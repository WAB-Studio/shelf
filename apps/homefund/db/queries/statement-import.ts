import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { trustedPatternsSql } from "@/db/queries/transactions";
import { withUserDb, type Transaction } from "@/db/session";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { proposalFor, type TrustedPattern } from "@/lib/ingest/counterparty-pattern";
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
  | "other_currency"
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

const idsJson = (values: (string | undefined)[]) =>
  JSON.stringify(values.filter((value): value is string => !!value));

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
          and s.source_ref in (select jsonb_array_elements_text(${idsJson(input.rows.map((one) => one.reference))}::jsonb))),
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
        where c.id::text in (select jsonb_array_elements_text(${idsJson(input.rows.map((one) => one.categoryId))}::jsonb))),
        '[]') as categories,
      coalesce((select json_agg(json_build_object('id', a.id, 'currency', a.settlement_currency))
        from accounts a
        where a.id::text in (select jsonb_array_elements_text(${idsJson(input.rows.map((one) => one.counterAccountId))}::jsonb))
          and a.archived_at is null), '[]') as accounts,
      ${trustedPatternsSql} as trusted`);
  return row!;
}

// Why the import could not write this line, mirroring the triggers that would refuse it: a split's
// category shares the movement's kind and scope, and a transfer stays in one currency (a statement
// line carries no counter amount).
function invalidReason(
  row: StatementRow,
  account: NonNullable<Context["account"]>,
  context: Context,
): InvalidReason | null {
  if (row.date < account.openedOn) return "before_opening";
  if (row.counterAccountId) {
    const other = context.accounts.find((one) => one.id === row.counterAccountId);
    if (!other) return "unknown_account";
    return other.currency === account.currency ? null : "other_currency";
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

function classify(input: StatementInput, context: Context): PreviewLine[] {
  const account = context.account!;
  const imported = new Map(context.refs.map((one) => [one.ref, one.transactionId]));
  // A movement already imported under one of these lines' references is spoken for: no other line
  // of the statement may match it.
  const taken = new Set(context.refs.map((one) => one.transactionId));
  return [...input.rows]
    .sort((a, b) => a.line - b.line)
    .map((row): PreviewLine => {
      const out = row.amountCents < 0;
      const kind = row.counterAccountId ? "transfer" : out ? "expense" : "income";
      const base = { line: row.line, kind, awaitsCounterparty: false } as const;
      const importedAs = row.reference === undefined ? undefined : imported.get(row.reference);
      if (importedAs) return { ...base, status: "already_imported", matchedTransactionId: importedAs };
      // The same day, the same amount, the same direction on this account. A leg sourced before is
      // this line only when neither carries a reference: a referenced line was looked up above.
      const match = context.candidates.find(
        (candidate) =>
          !taken.has(candidate.id) &&
          candidate.occurredAt === row.date &&
          candidate.legCents !== null &&
          Number(candidate.legCents) === Math.abs(row.amountCents) &&
          candidate.outOfAccount === out &&
          (!candidate.sourced || (row.reference === undefined && candidate.sourceRef === null)),
      );
      if (match) {
        taken.add(match.id);
        return { ...base, status: match.sourced ? "already_imported" : "matches", matchedTransactionId: match.id };
      }
      const reason = invalidReason(row, account, context);
      if (reason) return { ...base, status: "invalid", reason };
      const remembered = row.counterAccountId
        ? undefined
        : proposalFor(context.trusted, out ? "to" : "from", row.description);
      return {
        ...base,
        status: "new",
        awaitsCounterparty: !row.counterAccountId && row.unsure === true,
        ...(remembered ? { proposal: { accountId: remembered.accountId, accountName: remembered.accountLabel } } : {}),
      };
    });
}

// The key binds an import to the lines a preview showed AND to what it said about each: a line that
// would now be written differently changes it, so the import refuses rather than act unseen.
function previewKeyOf(input: StatementInput, lines: PreviewLine[]): string {
  const rows = [...input.rows].sort((a, b) => a.line - b.line);
  const said = lines.map((line) => [line.line, line.status, line.matchedTransactionId ?? null]);
  return createHash("sha256")
    .update(JSON.stringify({ accountId: input.accountId, rows, said }))
    .digest("hex")
    .slice(0, 32);
}

function summarise(input: StatementInput, context: Context): StatementPreview {
  const account = context.account;
  if (!account) throw new StatementError("notFound");
  if (!account.canWrite) throw new StatementError("readOnly");
  const lines = classify(input, context);
  const counts = { new: 0, matches: 0, already_imported: 0, invalid: 0 };
  for (const line of lines) counts[line.status] += 1;
  return {
    previewKey: previewKeyOf(input, lines),
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

// The movement alone: its split and source go in one batch once every movement exists, because a
// sibling insert in the same statement cannot see the row its policies look up.
async function insertMovement(tx: Transaction, accountId: string, row: StatementRow, awaits: boolean): Promise<string> {
  const out = row.amountCents < 0;
  const other = row.counterAccountId ?? null;
  const [movement] = await tx.execute<{ id: string }>(sql`
    insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, description, awaiting_counterparty)
    values (${out ? accountId : other}::uuid, ${out ? other : accountId}::uuid, ${Math.abs(row.amountCents)},
      ${row.date}, ${row.description}, ${awaits})
    returning id`);
  return movement!.id;
}

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
      // Each line's leg on this account: a matched movement gains only its source, a new one also its split.
      const legs: { transactionId: string; row: StatementRow; split: boolean }[] = [];
      for (const line of preview.lines) {
        const row = rows.get(line.line)!;
        if (line.status === "matches") legs.push({ transactionId: line.matchedTransactionId!, row, split: false });
        if (line.status !== "new") continue;
        current = line.line;
        const transactionId = await insertMovement(tx, input.accountId, row, line.awaitsCounterparty);
        legs.push({ transactionId, row, split: !row.counterAccountId });
      }
      current = undefined;
      const splits = legs.filter((leg) => leg.split);
      if (legs.length > 0) {
        const splitInsert =
          splits.length === 0
            ? sql``
            : sql`split as (
                insert into transaction_splits (transaction_id, category_id, amount_cents)
                values ${sql.join(
                  splits.map(
                    (leg) =>
                      sql`(${leg.transactionId}::uuid, ${leg.row.categoryId!}::uuid, ${Math.abs(leg.row.amountCents)}::bigint)`,
                  ),
                  sql`, `,
                )}),`;
        await tx.execute(sql`
          with ${splitInsert} source as (
            insert into transaction_sources (transaction_id, account_id, source_ref, source_seq)
            values ${sql.join(
              legs.map((leg) => {
                const { ref, seq } = sourceOf(leg.row);
                return sql`(${leg.transactionId}::uuid, ${input.accountId}::uuid, ${ref}, ${seq}::int)`;
              }),
              sql`, `,
            )})
          select 1`);
      }
    } catch (error) {
      console.error("statement line refused:", pgErrorCode(error) ?? "", pgConstraintName(error) ?? "");
      throw new StatementError("lineRefused", current);
    }
    return { created: preview.counts.new, linked: preview.counts.matches, skipped: preview.counts.already_imported };
  });
}
