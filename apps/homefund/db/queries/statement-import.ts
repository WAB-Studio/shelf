import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { jsonbParam } from "@/db/jsonb-param";
import { insertTransaction, trustedPatternsSql } from "@/db/queries/transactions";
import { withUserDb, type Transaction } from "@/db/session";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { learnedPattern, proposalFor, type TrustedPattern } from "@/lib/ingest/counterparty-pattern";
import type { StatementInput, StatementRow } from "@/lib/validation/statement-import";

// What a statement line becomes (RF-144, RF-134):
// - `new`: no movement records it yet; the import writes one.
// - `matches`: a movement the person already recorded (by hand, or the other side of a transfer read
//   off another statement); the import links this leg to it and writes nothing new.
// - `already_imported`: this leg already carries this line's source; the import skips it.
// - `invalid`: the import cannot write it; `reason` says why.
export type LineStatus = "new" | "matches" | "already_imported" | "invalid";

export type InvalidReason =
  | "needs_category_or_account"
  | "unknown_category"
  | "category_mismatch"
  | "unknown_account"
  | "needs_counter_amount"
  | "before_opening";

export type PreviewLine = {
  line: number;
  status: LineStatus;
  reason?: InvalidReason;
  kind: "income" | "expense" | "transfer";
  matchedTransactionId?: string;
  // RF-135: the other account a remembered pattern names for the missing side. A proposal only: the
  // import never fills it on its own; Claude passes it as `counterAccountId` once the person agrees.
  proposal?: { accountId: string; accountName: string };
  // A transfer across currencies: the other account's side, so the person confirms the rate.
  // `amountCents` is null while the line still lacks it (`needs_counter_amount`).
  counter?: { currency: string; amountCents: number | null };
  // Only on a new line the person marked unsure: it is written waiting for its other side (RF-133).
  awaitsCounterparty?: true;
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

type Context = {
  account: {
    id: string;
    name: string;
    currency: string;
    canWrite: boolean;
    openedOn: string;
    ownerUserId: string | null;
    groupId: string | null;
  } | null;
  // The movement each already-imported reference of this account belongs to.
  refs: { ref: string; transactionId: string }[];
  // `legCents` is the movement on this account, in its settlement currency: the counter amount when
  // the movement happened in another currency, so a statement line compares with what the bank booked.
  candidates: {
    id: string;
    occurredAt: string;
    legCents: string | null;
    outOfAccount: boolean;
    sourced: boolean;
    sourceRef: string | null;
  }[];
  categories: { id: string; kind: "income" | "expense"; ownerUserId: string | null; groupId: string | null }[];
  accounts: { id: string; currency: string }[];
  trusted: TrustedPattern[];
};

const idsParam = (values: (string | undefined)[]) => jsonbParam(values.filter((value): value is string => !!value));

// Everything the classification reads, in one round trip under the caller's policies.
async function readContext(tx: Transaction, input: StatementInput): Promise<Context> {
  const dates = input.rows.map((row) => row.date).sort();
  const [row] = await tx.execute<Context>(sql`
    select
      (select json_build_object('id', a.id, 'name', a.name, 'currency', a.settlement_currency,
          'canWrite', coalesce(private.can_write_account(a.id), false), 'openedOn', a.initial_balance_on,
          'ownerUserId', a.owner_user_id, 'groupId', a.group_id)
        from accounts a where a.id = ${input.accountId} and a.archived_at is null) as account,
      coalesce((select json_agg(json_build_object('ref', s.source_ref, 'transactionId', s.transaction_id))
        from transaction_sources s
        where s.account_id = ${input.accountId}
          and s.source_ref in (select jsonb_array_elements_text(${idsParam(input.rows.map((one) => one.reference))}))),
        '[]') as refs,
      coalesce((select json_agg(json_build_object('id', t.id, 'occurredAt', t.occurred_at,
          'legCents', (case when t.currency = a.settlement_currency then t.amount_cents
            else t.counter_amount_cents end)::text,
          'outOfAccount', t.from_account_id is not distinct from a.id,
          'sourced', s.id is not null, 'sourceRef', s.source_ref)
          order by t.created_at)
        from transactions t
        join accounts a on a.id = ${input.accountId}
        left join transaction_sources s on s.transaction_id = t.id and s.account_id = a.id
        where (t.from_account_id = a.id or t.to_account_id = a.id)
          and t.reconciliation_id is null
          and t.occurred_at between ${dates[0]}::date and ${dates[dates.length - 1]}::date), '[]') as candidates,
      coalesce((select json_agg(json_build_object('id', c.id, 'kind', c.kind,
          'ownerUserId', c.owner_user_id, 'groupId', c.group_id))
        from categories c
        where c.id in (select jsonb_array_elements_text(${idsParam(input.rows.map((one) => one.categoryId))})::uuid)),
        '[]') as categories,
      coalesce((select json_agg(json_build_object('id', a.id, 'currency', a.settlement_currency))
        from accounts a
        where a.id in (select jsonb_array_elements_text(${idsParam(input.rows.map((one) => one.counterAccountId))})::uuid)
          and a.archived_at is null), '[]') as accounts,
      ${trustedPatternsSql} as trusted`);
  return row!;
}

// Why the import could not write this line, mirroring the triggers that would refuse it: a split's
// category shares the movement's kind and scope, and a transfer across currencies carries what moved
// on the other account.
function invalidReason(
  row: StatementRow,
  account: NonNullable<Context["account"]>,
  context: Context,
): InvalidReason | null {
  if (row.date < account.openedOn) return "before_opening";
  if (row.counterAccountId) {
    const other = context.accounts.find((one) => one.id === row.counterAccountId);
    if (!other) return "unknown_account";
    return other.currency === account.currency || row.counterAmountCents !== undefined ? null : "needs_counter_amount";
  }
  if (!row.categoryId) return "needs_category_or_account";
  const category = context.categories.find((one) => one.id === row.categoryId);
  if (!category) return "unknown_category";
  const kind = row.amountCents < 0 ? "expense" : "income";
  return category.kind === kind &&
    category.ownerUserId === account.ownerUserId &&
    category.groupId === account.groupId
    ? null
    : "category_mismatch";
}

function classify(rows: StatementRow[], context: Context): PreviewLine[] {
  const account = context.account!;
  const imported = new Map(context.refs.map((one) => [one.ref, one.transactionId]));
  // A movement already imported under one of these lines' references is spoken for: no other line
  // of the statement may match it.
  const taken = new Set(context.refs.map((one) => one.transactionId));
  // Candidates by day, amount on this account and direction, oldest first.
  const byShape = new Map<string, Context["candidates"]>();
  for (const candidate of context.candidates) {
    if (candidate.legCents === null) continue;
    const shape = `${candidate.occurredAt}|${candidate.legCents}|${candidate.outOfAccount}`;
    byShape.set(shape, [...(byShape.get(shape) ?? []), candidate]);
  }
  return rows.map((row): PreviewLine => {
    const out = row.amountCents < 0;
    const kind = row.counterAccountId ? "transfer" : out ? "expense" : "income";
    const base = { line: row.line, kind } as const;
    const importedAs = row.reference === undefined ? undefined : imported.get(row.reference);
    if (importedAs) return { ...base, status: "already_imported", matchedTransactionId: importedAs };
    // The same day, the same amount, the same direction on this account. A leg sourced before is
    // this line only when neither carries a reference: a referenced line was looked up above.
    const match = byShape
      .get(`${row.date}|${Math.abs(row.amountCents)}|${out}`)
      ?.find(
        (candidate) =>
          !taken.has(candidate.id) &&
          (!candidate.sourced || (row.reference === undefined && candidate.sourceRef === null)),
      );
    if (match) {
      taken.add(match.id);
      return { ...base, status: match.sourced ? "already_imported" : "matches", matchedTransactionId: match.id };
    }
    const otherCurrency = context.accounts.find((one) => one.id === row.counterAccountId)?.currency;
    const counter =
      otherCurrency !== undefined && otherCurrency !== account.currency
        ? { counter: { currency: otherCurrency, amountCents: row.counterAmountCents ?? null } }
        : {};
    const reason = invalidReason(row, account, context);
    if (reason) return { ...base, status: "invalid", reason, ...counter };
    const remembered = row.counterAccountId
      ? undefined
      : proposalFor(context.trusted, out ? "to" : "from", learnedPattern(row.description).key);
    return {
      ...base,
      status: "new",
      ...counter,
      ...(!row.counterAccountId && row.unsure ? { awaitsCounterparty: true } : {}),
      ...(remembered ? { proposal: { accountId: remembered.accountId, accountName: remembered.accountLabel } } : {}),
    };
  });
}

// The key binds an import to the lines a preview showed AND to what it said about each: a line that
// would now be written differently changes it, so the import refuses rather than act unseen.
function previewKeyOf(accountId: string, rows: StatementRow[], lines: PreviewLine[]): string {
  const said = lines.map((line) => [line.line, line.status, line.matchedTransactionId ?? null]);
  return createHash("sha256")
    .update(JSON.stringify({ accountId, rows, said }))
    .digest("hex")
    .slice(0, 32);
}

function summarise(input: StatementInput, context: Context): StatementPreview {
  const account = context.account;
  if (!account) throw new StatementError("notFound");
  if (!account.canWrite) throw new StatementError("readOnly");
  const rows = [...input.rows].sort((a, b) => a.line - b.line);
  const lines = classify(rows, context);
  const counts = { new: 0, matches: 0, already_imported: 0, invalid: 0 };
  for (const line of lines) counts[line.status] += 1;
  return {
    previewKey: previewKeyOf(input.accountId, rows, lines),
    account: { id: account.id, name: account.name, currency: account.currency },
    lines,
    counts,
  };
}

/** RF-144's mandatory first step: what an import of these lines would do, writing nothing. */
export async function previewStatement(input: StatementInput): Promise<StatementPreview> {
  return withUserDb(async (tx) => summarise(input, await readContext(tx, input)));
}

const sourceOf = (row: StatementRow) => ({ ref: row.reference ?? null, seq: row.reference ? null : row.line });

/**
 * Writes what the preview with this key showed, in one transaction: a new line becomes a movement
 * with its source (RF-134), a matched one gains its source, an imported one is skipped. A changed
 * classification, or an invalid line, writes nothing.
 */
export async function importStatement(
  input: StatementInput & { previewKey: string },
): Promise<StatementImportResult> {
  return withUserDb(async (tx) => {
    // Two imports of one account (a retry while the first still runs) take turns: the second reads
    // after the first committed, so a line without a reference is not written twice.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`statement:${input.accountId}`}, 0))`);
    const preview = summarise(input, await readContext(tx, input));
    if (preview.previewKey !== input.previewKey) throw new StatementError("previewChanged");
    if (preview.counts.invalid > 0) throw new StatementError("invalidLines");
    const rows = new Map(input.rows.map((row) => [row.line, row]));
    let current: number | undefined;
    try {
      // Each line's leg on this account: a matched movement gains only its source.
      const legs: { transactionId: string; row: StatementRow }[] = [];
      for (const line of preview.lines) {
        const row = rows.get(line.line)!;
        if (line.status === "matches") legs.push({ transactionId: line.matchedTransactionId!, row });
        if (line.status !== "new") continue;
        current = line.line;
        const out = row.amountCents < 0;
        const amountCents = Math.abs(row.amountCents);
        const other = row.counterAccountId ?? null;
        // Booked in this statement's currency; the other account's side rides as the counter amount.
        const { transactionId } = await insertTransaction(tx, {
          fromAccountId: out ? input.accountId : other,
          toAccountId: out ? other : input.accountId,
          amountCents,
          ...(line.counter ? { currency: preview.account.currency, counterAmountCents: line.counter.amountCents } : {}),
          awaitingCounterparty: line.awaitsCounterparty === true,
          occurredAt: row.date,
          description: row.description,
          externalRef: null,
          splits: other ? [] : [{ categoryId: row.categoryId!, amountCents }],
          labelIds: [],
        });
        legs.push({ transactionId, row });
      }
      current = undefined;
      if (legs.length > 0) {
        await tx.execute(sql`
          insert into transaction_sources (transaction_id, account_id, source_ref, source_seq)
          values ${sql.join(
            legs.map((leg) => {
              const { ref, seq } = sourceOf(leg.row);
              return sql`(${leg.transactionId}::uuid, ${input.accountId}::uuid, ${ref}, ${seq}::int)`;
            }),
            sql`, `,
          )}`);
      }
    } catch (error) {
      console.error("statement line refused:", pgErrorCode(error) ?? "", pgConstraintName(error) ?? "");
      throw new StatementError("lineRefused", current);
    }
    return { created: preview.counts.new, linked: preview.counts.matches, skipped: preview.counts.already_imported };
  });
}
