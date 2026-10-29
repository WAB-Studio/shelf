import "server-only";

import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accounts } from "@/db/schema";
import type { Account } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { withUserDb, withUserDbOrTx } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";

type AccountKind = Account["kind"];
type AccountSubtype = Account["subtype"];

export type AccountRow = {
  id: string;
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  institution: string | null;
  lastFour?: string | null;
  ownerUserId: string | null;
  groupId: string | null;
  isShared: boolean;
  settlementCurrency: CurrencyCode;
  initialBalanceCents: number;
  initialBalanceOn: string;
  // One balance per currency the account holds, its settlement currency first
  // (RF-121, RF-124). No caller adds two of them together.
  balances: { currency: CurrencyCode; balanceCents: number }[];
  // What the policies would admit on this account, so a screen offers no action
  // the database would refuse (RF-58, RF-100).
  canWrite: boolean;
  archivedAt: Date | null;
  // `updated_at::text` as Postgres prints it; an edit sends it back so a save after someone
  // else's is refused stale.
  // Absent on the rows `cash.ts` builds, which no form edits.
  updatedAt?: string;
};

// Every account the caller may read: their personal accounts and their group's
// (RF-58, universal read). The policy scopes the rows; ordering only groups
// personal accounts ahead of the group's, then by name. The balance and the write
// privilege ride this same statement (RNF-07, RNF-09) — the roster costs one
// round trip, as before.
export async function listAccounts(
  options: { archived: boolean },
  outerTx?: Transaction,
): Promise<AccountRow[]> {
  // The outer references are written qualified, once each: drizzle renders an
  // embedded column bare inside a projection, and a bare `id` binds to the view
  // the subquery reads, which turns the correlation into one constant for the
  // whole result set.
  const outerId = sql`"accounts"."id"`;
  const outerCurrency = sql`"accounts"."settlement_currency"`;

  // A correlated subquery and not a join: the view answers one row per account
  // AND currency (RF-121), so a join would return the account once per currency
  // it holds. `::text` keeps a bigint out of a JSON number.
  const balancesJson = sql<{ currency: string; balanceCents: string }[]>`coalesce((
    select jsonb_agg(
      jsonb_build_object('currency', b.currency, 'balanceCents', b.balance_cents::text)
      order by (b.currency = ${outerCurrency}) desc, b.currency
    )
    from account_balances b where b.id = ${outerId}
  ), '[]'::jsonb)`;

  return withUserDbOrTx(outerTx, async (tx) => {
    const rows = await tx
      .select({
        id: accounts.id,
        name: accounts.name,
        kind: accounts.kind,
        subtype: accounts.subtype,
        institution: accounts.institution,
        lastFour: accounts.lastFour,
        ownerUserId: accounts.ownerUserId,
        groupId: accounts.groupId,
        isShared: accounts.isShared,
        settlementCurrency: accounts.settlementCurrency,
        initialBalanceCents: accounts.initialBalanceCents,
        initialBalanceOn: accounts.initialBalanceOn,
        // The view derives every balance from movements, never a stored column,
        // and runs `security_invoker`: it shows what the account policy already
        // showed. An account always answers at least its settlement row, so the
        // empty fallback is the shape of the expression, not a state a row reaches.
        balances: balancesJson,
        // Written with the column's own name, never a Drizzle column reference: a
        // reference inside a projection fragment renders bare and binds inward.
        canWrite: sql<boolean>`private.can_write_account(accounts.id)`,
        archivedAt: accounts.archivedAt,
        updatedAt: sql<string>`accounts.updated_at::text`,
      })
      .from(accounts)
      .where(
        options.archived ? isNotNull(accounts.archivedAt) : isNull(accounts.archivedAt),
      )
      .orderBy(desc(sql`${accounts.ownerUserId} is not null`), asc(accounts.name));

    // A bigint sum rides the aggregate as text; the ledger keeps the amount a
    // number, in the minor unit of the currency beside it.
    return rows.map((row) => ({
      ...row,
      balances: row.balances.map((balance) => ({
        currency: balance.currency,
        balanceCents: Number(balance.balanceCents),
      })),
    }));
  });
}

// Placement is XOR, mirroring the schema check: a personal account names its
// owner, a group account names its group and may be shared.
export type CreateAccountArgs = {
  name: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  ownerUserId: string | null;
  groupId: string | null;
  isShared: boolean;
  institution: string | null;
  lastFour?: string | null;
  // The currency the account settles in, and the opening amount as an integer
  // in that currency's minor unit (RF-121, RNF-05).
  settlementCurrency: CurrencyCode;
  amountMinor: number;
  balanceOn: string;
};

export async function createAccount(
  args: CreateAccountArgs,
): Promise<{ accountId: string }> {
  return withUserDb((tx) => insertAccount(tx, args));
}

// The insert body of `createAccount`: the wrapper opens the session, this runs
// the statement inside whatever transaction it is handed.
async function insertAccount(
  tx: Transaction,
  {
    name,
    kind,
    subtype,
    ownerUserId,
    groupId,
    isShared,
    institution,
    lastFour,
    settlementCurrency,
    amountMinor,
    balanceOn,
  }: CreateAccountArgs,
): Promise<{ accountId: string }> {
  const [row] = await insertRow(
    tx,
    accounts,
    {
      name,
      kind,
      // Passed explicitly; `set_account_subtype` only fills an omitted one.
      subtype,
      ownerUserId,
      groupId,
      isShared,
      // A blank field means "no institution", the same as an absent one.
      institution: institution === "" ? null : institution,
      lastFour: lastFour ? lastFour : null,
      settlementCurrency,
      // A liability opens negative so net worth stays a plain sum (RNF-05). The
      // amount arrives already in this currency's minor unit and is written as
      // it came. It is cast explicitly: an untyped param leaves unary minus with
      // no single best operator, and Postgres refuses to parse the case.
      initialBalanceCents: sql`case when ${kind} = 'liability' then -${amountMinor}::bigint else ${amountMinor}::bigint end`,
      initialBalanceOn: balanceOn,
    },
    { returning: { id: accounts.id } },
  );

  return { accountId: row.id };
}

// Neither `kind` nor the owner/group pivot is in the update grant, so an edit
// only touches these fields; `is_shared` toggles whether the group may write it.
export type UpdateAccountArgs = {
  accountId: string;
  name: string;
  subtype: AccountSubtype;
  isShared: boolean;
  institution: string | null;
  lastFour?: string | null;
  settlementCurrency: CurrencyCode;
  amountMinor: number;
  balanceOn: string;
  expectedUpdatedAt?: string;
};

// Without a stamp the answer is only whether a row was written; with one it may be "stale".
export async function updateAccount(
  args: UpdateAccountArgs & { expectedUpdatedAt?: undefined },
): Promise<boolean>;
export async function updateAccount(args: UpdateAccountArgs): Promise<boolean | "stale">;
export async function updateAccount({
  accountId,
  name,
  subtype,
  isShared,
  institution,
  lastFour,
  settlementCurrency,
  amountMinor,
  balanceOn,
  expectedUpdatedAt,
}: UpdateAccountArgs): Promise<boolean | "stale"> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(accounts)
      .set({
        name,
        // A bank account may become cash or the reverse; the kind holds it (RF-56).
        subtype,
        isShared,
        institution: institution === "" ? null : institution,
        lastFour: lastFour ? lastFour : null,
        // Granted for update since 0031, so the opening amount and the unit it
        // is counted in always change together.
        settlementCurrency,
        // `kind` is immutable and absent from the grant, so it is read from
        // the row itself rather than named in this `set`. The amount is cast
        // explicitly for the same reason as in `createAccount`.
        initialBalanceCents: sql`case when ${accounts.kind} = 'liability' then -${amountMinor}::bigint else ${amountMinor}::bigint end`,
        initialBalanceOn: balanceOn,
      })
      .where(
        and(
          eq(accounts.id, accountId),
          // Compared as text: a JS Date would drop the microseconds (docs/TRAPS.md).
          expectedUpdatedAt
            ? sql`${accounts.updatedAt} = ${expectedUpdatedAt}::text::timestamptz`
            : undefined,
        ),
      )
      .returning({ id: accounts.id });

    if (rows.length > 0) return true;
    if (!expectedUpdatedAt) return false;

    // Only a refused write pays for this: a readable row means the stamp moved.
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row ? "stale" : false;
  });
}

// RF-61: a personal account becomes the group's in one statement. No group id
// crosses the boundary — `private.hand_account_to_group` reads auth.uid(), takes
// the caller's own group and refuses an account carrying any history, which is
// archived instead. `AccountRow` is unchanged: the next `listAccounts` reads the
// new placement. A refusal is a 23514 the action layer reads.
export async function handAccountToGroup({
  accountId,
}: {
  accountId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ ok: boolean }>(
      sql`select private.hand_account_to_group(${accountId}) as ok`,
    );

    return rows[0]?.ok === true;
  });
}

export async function archiveAccount({
  accountId,
}: {
  accountId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(accounts)
      .set({ archivedAt: sql`now()` })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id });

    return rows.length > 0;
  });
}

export async function restoreAccount({
  accountId,
}: {
  accountId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(accounts)
      .set({ archivedAt: null })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id });

    return rows.length > 0;
  });
}

export async function deleteAccount({
  accountId,
}: {
  accountId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(accounts)
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id });

    return rows.length > 0;
  });
}
