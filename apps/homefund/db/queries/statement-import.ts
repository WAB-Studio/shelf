import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { insertTransaction } from "@/db/queries/transactions";
import { withUserDb, type Transaction } from "@/db/session";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { counterpartyPatternKey } from "@/lib/ingest/counterparty-pattern";
import type { StatementInput, StatementRow } from "@/lib/validation/statement-import";

// What a statement line becomes (RF-144, RF-134):
// - `new`: no movement records it yet; the import writes one.
// - `matches`: a movement the person already recorded (by hand, or the other side of a transfer read
//   off another statement); the import links this leg to it and writes nothing new.
// - `already_imported`: this leg already carries a source; the import skips it.
// - `invalid`: the import cannot write it; `reason` says why.
export type LineStatus = "new" | "matches" | "already_imported" | "invalid";

export type InvalidReason = "needs_category_or_account" | "unknown_category" | "unknown_account" | "before_opening";

export type PreviewLine = {
  line: number;
  status: LineStatus;
  reason?: InvalidReason;
  kind: "income" | "expense" | "transfer";
  matchedTransactionId?: string;
  // RF-135: the other account a remembered pattern names for the missing side. A proposal only: the
  // import never fills it on its own; Claude passes it as `counterAccountId` once the person agrees.
  proposal?: { accountId: string; accountName: string };
  awaitsCounterparty: boolean;
};

export type StatementPreview = {
  previewKey: string;
  account: { id: string; name: string; currency: string };
  lines: PreviewLine[];
  counts: Record<LineStatus, number>;
};

export type StatementImportResult = { created: number; linked: number; skipped: number };

export class StatementError extends Error {
  constructor(
    readonly key: "notFound" | "readOnly" | "previewChanged" | "invalidLines" | "lineRefused",
    readonly line?: number,
  ) {
    super(key);
  }
}

// The key binds an import to the exact lines a preview showed: any change to them changes it.
export function previewKeyOf(input: StatementInput): string {
  const rows = [...input.rows].sort((a, b) => a.line - b.line);
  return createHash("sha256").update(JSON.stringify({ accountId: input.accountId, rows })).digest("hex").slice(0, 32);
}

type Candidate = {
  id: string;
  occurred_at: string;
  amount_cents: string;
  from_account_id: string | null;
  to_account_id: string | null;
  sourced: boolean;
};

// Everything the classification reads, in one round trip under the caller's policies.
async function readContext(tx: Transaction, input: StatementInput) {
  const dates = input.rows.map((row) => row.date).sort();
  const refs = input.rows.flatMap((row) => (row.reference ? [row.reference] : []));
  const categoryIds = input.rows.flatMap((row) => (row.categoryId ? [row.categoryId] : []));
  const accountIds = input.rows.flatMap((row) => (row.counterAccountId ? [row.counterAccountId] : []));
  const [row] = await tx.execute<{
    account: { id: string; name: string; currency: string; canWrite: boolean; openedOn: string } | null;
    refs: string[];
    candidates: Candidate[];
    categories: string[];
    accounts: string[];
    trusted: { patternKey: string; side: "from" | "to"; accountId: string; accountName: string }[];
  }>(sql`
    select
      (select json_build_object('id', a.id, 'name', a.name, 'currency', a.settlement_currency,
          'canWrite', coalesce(private.can_write_account(a.id), false), 'openedOn', a.initial_balance_on)
        from accounts a where a.id = ${input.accountId} and a.archived_at is null) as account,
      coalesce((select json_agg(s.source_ref) from transaction_sources s
        where s.account_id = ${input.accountId} and s.source_ref in (select jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb))), '[]') as refs,
      coalesce((select json_agg(json_build_object('id', t.id, 'occurred_at', t.occurred_at,
          'amount_cents', t.amount_cents::text, 'from_account_id', t.from_account_id,
          'to_account_id', t.to_account_id,
          'sourced', exists (select 1 from transaction_sources s
            where s.transaction_id = t.id and s.account_id = ${input.accountId}))
          order by t.created_at)
        from transactions t
        where (t.from_account_id = ${input.accountId} or t.to_account_id = ${input.accountId})
          and t.reconciliation_id is null
          and t.occurred_at between ${dates[0]}::date and ${dates[dates.length - 1]}::date), '[]') as candidates,
      coalesce((select json_agg(c.id) from categories c
        where c.id::text in (select jsonb_array_elements_text(${JSON.stringify(categoryIds)}::jsonb))), '[]') as categories,
      coalesce((select json_agg(a.id) from accounts a
        where a.id::text in (select jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)) and a.archived_at is null), '[]') as accounts,
      coalesce((select json_agg(json_build_object('patternKey', c.pattern_key, 'side', c.side,
          'accountId', c.trusted_account_id, 'accountName', a.name))
        from ingest_counterparties c join accounts a on a.id = c.trusted_account_id
        where c.state = 'trusted'), '[]') as trusted`);
  return row;
}

function classify(input: StatementInput, context: Awaited<ReturnType<typeof readContext>>): PreviewLine[] {
  const account = context.account!;
  const refs = new Set(context.refs);
  const categories = new Set(context.categories);
  const accounts = new Set(context.accounts);
  const taken = new Set<string>();
  return [...input.rows]
    .sort((a, b) => a.line - b.line)
    .map((row): PreviewLine => {
      const out = row.amountCents < 0;
      const kind = row.counterAccountId ? "transfer" : out ? "expense" : "income";
      const base = { line: row.line, kind, awaitsCounterparty: false } as const;
      if (row.reference !== undefined && refs.has(row.reference)) return { ...base, status: "already_imported" };
      // The same day, the same amount, the same direction on this account: the movement already there.
      const match = context.candidates.find(
        (candidate) =>
          !taken.has(candidate.id) &&
          candidate.occurred_at === row.date &&
          Number(candidate.amount_cents) === Math.abs(row.amountCents) &&
          (out ? candidate.from_account_id : candidate.to_account_id) === account.id,
      );
      if (match) {
        taken.add(match.id);
        return { ...base, status: match.sourced ? "already_imported" : "matches", matchedTransactionId: match.id };
      }
      if (row.date < account.openedOn) return { ...base, status: "invalid", reason: "before_opening" };
      if (row.counterAccountId && !accounts.has(row.counterAccountId)) {
        return { ...base, status: "invalid", reason: "unknown_account" };
      }
      if (!row.counterAccountId && !row.categoryId) {
        return { ...base, status: "invalid", reason: "needs_category_or_account" };
      }
      if (row.categoryId && !categories.has(row.categoryId)) return { ...base, status: "invalid", reason: "unknown_category" };
      const side = out ? "to" : "from";
      const key = counterpartyPatternKey(row.description);
      const remembered = row.counterAccountId
        ? undefined
        : context.trusted.find((pattern) => pattern.side === side && pattern.patternKey === key);
      return {
        ...base,
        status: "new",
        awaitsCounterparty: !row.counterAccountId && row.unsure === true,
        ...(remembered ? { proposal: { accountId: remembered.accountId, accountName: remembered.accountName } } : {}),
      };
    });
}

function summarise(input: StatementInput, context: Awaited<ReturnType<typeof readContext>>): StatementPreview {
  const account = context.account;
  if (!account) throw new StatementError("notFound");
  if (!account.canWrite) throw new StatementError("readOnly");
  const lines = classify(input, context);
  const counts = { new: 0, matches: 0, already_imported: 0, invalid: 0 };
  for (const line of lines) counts[line.status] += 1;
  return {
    previewKey: previewKeyOf(input),
    account: { id: account.id, name: account.name, currency: account.currency },
    lines,
    counts,
  };
}

/** RF-144's mandatory first step: what an import of these lines would do, writing nothing. */
export async function previewStatement(input: StatementInput): Promise<StatementPreview> {
  return withUserDb(async (tx) => summarise(input, await readContext(tx, input)));
}

async function recordSource(tx: Transaction, transactionId: string, accountId: string, row: StatementRow) {
  await tx.execute(sql`
    insert into transaction_sources (transaction_id, account_id, source_ref, source_seq)
    values (${transactionId}, ${accountId}, ${row.reference ?? null}, ${row.reference ? null : row.line})`);
}

/**
 * Writes what the preview with this key showed, in one transaction: a new line becomes a movement
 * with its source (RF-134), a matched one gains its source, an imported one is skipped. A changed
 * statement, or one with invalid lines, writes nothing.
 */
export async function importStatement(input: StatementInput & { previewKey: string }): Promise<StatementImportResult> {
  return withUserDb(async (tx) => {
    const preview = summarise(input, await readContext(tx, input));
    if (preview.previewKey !== input.previewKey) throw new StatementError("previewChanged");
    if (preview.counts.invalid > 0) throw new StatementError("invalidLines");
    const rows = new Map(input.rows.map((row) => [row.line, row]));
    const result = { created: 0, linked: 0, skipped: 0 };
    for (const line of preview.lines) {
      const row = rows.get(line.line)!;
      try {
        if (line.status === "already_imported") {
          result.skipped += 1;
        } else if (line.status === "matches") {
          await recordSource(tx, line.matchedTransactionId!, input.accountId, row);
          result.linked += 1;
        } else {
          const out = row.amountCents < 0;
          const amountCents = Math.abs(row.amountCents);
          const other = row.counterAccountId ?? null;
          const { transactionId } = await insertTransaction(tx, {
            fromAccountId: out ? input.accountId : other,
            toAccountId: out ? other : input.accountId,
            amountCents,
            occurredAt: row.date,
            description: row.description,
            externalRef: null,
            splits: other ? [] : [{ categoryId: row.categoryId!, amountCents }],
            labelIds: [],
          });
          if (line.awaitsCounterparty) {
            await tx.execute(sql`update transactions set awaiting_counterparty = true where id = ${transactionId}`);
          }
          await recordSource(tx, transactionId, input.accountId, row);
          result.created += 1;
        }
      } catch (error) {
        console.error("statement line refused:", pgErrorCode(error) ?? "", pgConstraintName(error) ?? "");
        throw new StatementError("lineRefused", line.line);
      }
    }
    return result;
  });
}
