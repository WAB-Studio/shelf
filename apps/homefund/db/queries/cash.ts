import "server-only";

import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import type { AccountRow } from "@/db/queries/accounts";
import { callerCashMode, callerGroupId } from "@/db/queries/groups";
import { insertTransaction } from "@/db/queries/transactions";
import { accounts } from "@/db/schema";
import type { Transaction } from "@/db/session";
import { requireUser, withUserDb } from "@/db/session";
import { todayInBogota } from "@/lib/dates";
import { TIME_ZONE } from "@/lib/locales";

// Where a cash withdrawal lands and what it may draw from (RF-68). The target is
// the sole `subtype = 'efectivo'` account the mode points at; `sourceAccounts`
// are the non-cash asset accounts the caller may write, i.e. what a withdrawal
// takes money out of. `reason` names why a target is missing, so the caller can
// decide to create-on-demand — a write path this read never takes.
export type WithdrawalTarget = {
  targetCashAccountId: string | null;
  sourceAccounts: AccountRow[];
  reason?: "no-cash-account";
};

// The outer references are written qualified, once each: drizzle renders an
// embedded column bare inside a projection, and a bare `id` binds to the view
// the subquery reads, which turns the correlation into one constant.
const outerId = sql`"accounts"."id"`;
const outerCurrency = sql`"accounts"."settlement_currency"`;

// One balance per currency, the settlement one first (RF-121, RF-124). A
// correlated subquery and not a join: `account_balances` answers one row per
// account AND currency, so a join would list a source account once per currency
// it holds.
const balancesJson = sql<{ currency: string; balanceCents: string }[]>`coalesce((
  select jsonb_agg(
    jsonb_build_object('currency', b.currency, 'balanceCents', b.balance_cents::text)
    order by (b.currency = ${outerCurrency}) desc, b.currency
  )
  from account_balances b where b.id = ${outerId}
), '[]'::jsonb)`;

const accountRowColumns = {
  id: accounts.id,
  name: accounts.name,
  kind: accounts.kind,
  subtype: accounts.subtype,
  institution: accounts.institution,
  ownerUserId: accounts.ownerUserId,
  groupId: accounts.groupId,
  isShared: accounts.isShared,
  settlementCurrency: accounts.settlementCurrency,
  initialBalanceCents: accounts.initialBalanceCents,
  initialBalanceOn: accounts.initialBalanceOn,
  balances: balancesJson,
  // Written with the column's own name, never a Drizzle column reference: a
  // reference inside a projection fragment renders bare and binds inward. The
  // WHERE below already keeps this list to own-or-shared, so it reads true here.
  canWrite: sql<boolean>`private.can_write_account(accounts.id)`,
  archivedAt: accounts.archivedAt,
} as const;

/**
 * Where the caller's cash sits, as a predicate: under 'shared' it is the group's
 * one `efectivo` account, under every other mode — per-member, or personal-only
 * (RF-55) — it is their own, which never resolves to another member's. Mode and
 * membership resolve inside the statement, so naming the scope costs no read.
 */
function cashScope(userId: string): SQL {
  return sql`case when ${callerCashMode(userId)} = 'shared'
    then ${accounts.groupId} = ${callerGroupId(userId)}
    else ${accounts.ownerUserId} = ${userId} end`;
}

/**
 * Resolves a withdrawal's cash destination and its possible sources. The target
 * lookup and the source list are independent, so they fan out — with nothing
 * chained ahead of them.
 */
export async function resolveWithdrawalTarget(): Promise<WithdrawalTarget> {
  const user = await requireUser();
  const targetScope = cashScope(user.id);

  const [targetCashAccountId, sourceAccounts] = await Promise.all([
    findCashAccountId(targetScope),
    listWithdrawalSources(user.id),
  ]);

  if (targetCashAccountId === null) {
    return { targetCashAccountId, sourceAccounts, reason: "no-cash-account" };
  }

  return { targetCashAccountId, sourceAccounts };
}

// The one live `efectivo` account inside the given scope, RLS-scoped on top. A
// stable order keeps the pick deterministic if a scope ever holds more than one.
async function findCashAccountId(scope: SQL): Promise<string | null> {
  return withUserDb((tx) => findCashAccountIdTx(tx, scope));
}

// The same lookup against a caller-supplied transaction, so the withdrawal write
// can resolve, create and insert in one atomic round.
async function findCashAccountIdTx(
  tx: Transaction,
  scope: SQL,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(scope, eq(accounts.subtype, "efectivo"), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.createdAt))
    .limit(1);

  return row?.id ?? null;
}

export type WithdrawCashArgs = {
  sourceAccountId: string;
  amountCents: number;
  // The name a create-on-demand cash account takes, in the caller's locale (RF-64);
  // read only when none exists yet.
  cashAccountName: string;
};

export type WithdrawCashResult = {
  transactionId: string;
  targetCashAccountId: string;
  createdCashAccount: boolean;
};

/**
 * Writes a cash withdrawal as a transfer source→cash, in one transaction (RF-68,
 * RF-40). The target is the caller's cash by `cash_mode`: the group's under
 * 'shared', their own otherwise. A per-member or personal caller with no cash yet
 * has it created here, seeded at zero like the fund's own (RF-56), so the resolve,
 * the create and the transfer commit or roll back together. The movement names
 * both accounts and carries no split and no category — a transfer's type is the
 * DB's to derive (RF-18, RF-19).
 */
export async function withdrawCash({
  sourceAccountId,
  amountCents,
  cashAccountName,
}: WithdrawCashArgs): Promise<WithdrawCashResult> {
  const user = await requireUser();
  const targetScope = cashScope(user.id);

  return withUserDb(async (tx) => {
    let targetCashAccountId = await findCashAccountIdTx(tx, targetScope);
    let createdCashAccount = false;

    // No cash under the caller's scope: create their personal `efectivo` account
    // and draw into it. 'shared' always has the group's cash, so this only ever
    // fires for a per-member or personal caller (RF-55, RF-56).
    if (targetCashAccountId === null) {
      const [row] = await insertRow(
        tx,
        accounts,
        {
          groupId: null,
          ownerUserId: user.id,
          isShared: false,
          name: cashAccountName,
          kind: "asset",
          subtype: "efectivo",
          initialBalanceCents: 0,
          initialBalanceOn: sql`(now() at time zone ${TIME_ZONE})::date`,
        },
        { returning: { id: accounts.id } },
      );

      targetCashAccountId = row.id;
      createdCashAccount = true;
    }

    const { transactionId } = await insertTransaction(tx, {
      fromAccountId: sourceAccountId,
      toAccountId: targetCashAccountId,
      amountCents,
      occurredAt: todayInBogota(),
      description: null,
      externalRef: null,
      splits: [],
      labelIds: [],
    });

    return { transactionId, targetCashAccountId, createdCashAccount };
  });
}

// The caller's writable, live, non-cash asset accounts — what a withdrawal draws
// FROM. Writable is own-or-shared, mirroring the accounts INSERT policy; the
// `efectivo` subtype is excluded so cash never draws from cash.
async function listWithdrawalSources(userId: string): Promise<AccountRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select(accountRowColumns)
      .from(accounts)
      .where(
        and(
          eq(accounts.kind, "asset"),
          ne(accounts.subtype, "efectivo"),
          isNull(accounts.archivedAt),
          or(eq(accounts.ownerUserId, userId), eq(accounts.isShared, true)),
        ),
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
