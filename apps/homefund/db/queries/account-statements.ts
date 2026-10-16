import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { accounts, accountStatements } from "@/db/schema";
import type { AccountStatement } from "@/db/schema";
import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";

export type AccountStatementRow = AccountStatement & {
  // The account's own balance at the cut-off, in its settlement currency.
  derivedBalanceCents: number;
  // What the close claims over what the movements say. Zero when they agree.
  reconciliationGapCents: number;
};

/**
 * Any account's closes, newest first, each with its reconciliation gap (RF-129).
 * ONE round trip: the derived balance rides the same projection as the stored
 * snapshot, correlated per row, never a read per statement.
 *
 * Nothing is generated here. A period nobody recorded is absent, and the gap is
 * computed on read from the movements — neither figure is ever stored (RNF-07).
 * Every column inside the fragment is written with its own name: an embedded
 * Drizzle column renders bare in a projection and binds to the inner table.
 */
export async function listAccountStatements(
  accountId: string,
): Promise<AccountStatementRow[]> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .select({
        statement: accountStatements,
        // The opening balance is one row in the settlement currency, so the walk
        // to the cut-off starts there and stays in that one pocket. Each leg lands
        // the way `account_balances` lands it (RF-121, RF-124): its own amount
        // while it was spent in that currency, what the issuer billed once a
        // confirmed second amount says so, and nothing while that figure is still
        // an estimate.
        derivedBalanceCents: sql<string>`
          accounts.initial_balance_cents
            + coalesce((select sum(case
                when t.currency = accounts.settlement_currency then t.amount_cents
                when t.counter_amount_cents is not null and not t.counter_is_estimate
                  then t.counter_amount_cents
                else 0
              end) from transactions t
              where t.to_account_id = account_statements.account_id
                and t.occurred_at <= account_statements.cut_off_date), 0)
            - coalesce((select sum(case
                when t.currency = accounts.settlement_currency then t.amount_cents
                when t.counter_amount_cents is not null and not t.counter_is_estimate
                  then t.counter_amount_cents
                else 0
              end) from transactions t
              where t.from_account_id = account_statements.account_id
                and t.occurred_at <= account_statements.cut_off_date), 0)
        `,
      })
      .from(accountStatements)
      .innerJoin(accounts, eq(accounts.id, accountStatements.accountId))
      .where(eq(accountStatements.accountId, accountId))
      .orderBy(desc(accountStatements.cutOffDate));

    return rows.map(({ statement, derivedBalanceCents }) => {
      // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
      const derived = Number(derivedBalanceCents);

      return {
        ...statement,
        derivedBalanceCents: derived,
        reconciliationGapCents: statement.closingBalanceCents - derived,
      };
    });
  });
}

// Every figure travels as an unsigned magnitude; only `closingBalanceCents` and
// `openingBalanceCents` carry a sign, and it is resolved in SQL from `accounts.kind`
// (RF-129), never sent by the caller — the same shape as `createAccount`'s opening
// balance, adapted to a row that already exists rather than one this statement writes.
export type RecordAccountStatementArgs = {
  accountId: string;
  periodStart: string;
  cutOffDate: string;
  paymentDueDate: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number;
  creditsCents: number | null;
  debitsCents: number | null;
  minimumPaymentCents: number | null;
  interestChargedCents: number | null;
  feesChargedCents: number | null;
};

// A magnitude signed like the account it belongs to: negative on a liability,
// positive on an asset. The account's own `kind` decides it, read by a correlated
// subquery since the insert this rides in names no `accounts` row to join.
function signedByAccountKind(accountId: string, magnitudeCents: number) {
  return sql`case when (select kind from accounts where id = ${accountId}) = 'liability'
    then -${magnitudeCents}::bigint else ${magnitudeCents}::bigint end`;
}

/**
 * Cuts one immutable snapshot for a period nobody has recorded yet (RF-129, RF-130).
 * `insertRow` names only the twelve columns the grant covers; `source`, `id` and
 * `closed_at` stay on their own defaults. Null when the policy denied the write —
 * `can_write_account` failed — read from the driver's own refusal (`42501`) rather
 * than thrown, so a caller reads it the same way a denied `select` reads empty.
 */
export async function recordAccountStatement(
  args: RecordAccountStatementArgs,
): Promise<{ id: string } | null> {
  try {
    return await withUserDb(async (tx) => {
      const [row] = await insertRow(
        tx,
        accountStatements,
        {
          accountId: args.accountId,
          periodStart: args.periodStart,
          cutOffDate: args.cutOffDate,
          paymentDueDate: args.paymentDueDate,
          openingBalanceCents:
            args.openingBalanceCents === null
              ? null
              : signedByAccountKind(args.accountId, args.openingBalanceCents),
          closingBalanceCents: signedByAccountKind(args.accountId, args.closingBalanceCents),
          creditsCents: args.creditsCents,
          debitsCents: args.debitsCents,
          minimumPaymentCents: args.minimumPaymentCents,
          interestChargedCents: args.interestChargedCents,
          feesChargedCents: args.feesChargedCents,
        },
        { returning: { id: accountStatements.id } },
      );

      return { id: row.id };
    });
  } catch (error) {
    if (pgErrorCode(error) === "42501") return null;
    throw error;
  }
}

export type AccountStatementHistory = {
  account: {
    id: string;
    name: string;
    kind: "asset" | "liability";
    institution: string | null;
    settlementCurrency: CurrencyCode;
    // The day after the last recorded cut-off, or the account's own opening day
    // when no statement has ever closed it.
    nextPeriodStart: string;
    canWrite: boolean;
  };
  statements: AccountStatementRow[];
};

async function readStatementHistoryAccount(
  accountId: string,
): Promise<AccountStatementHistory["account"] | null> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({
        id: accounts.id,
        name: accounts.name,
        kind: accounts.kind,
        institution: accounts.institution,
        settlementCurrency: accounts.settlementCurrency,
        nextPeriodStart: sql<string>`coalesce(
          (select max(s.cut_off_date) + 1 from account_statements s where s.account_id = accounts.id),
          accounts.initial_balance_on
        )`,
        // Written with the column's own name, never a Drizzle column reference: a
        // reference inside a projection fragment renders bare and binds inward.
        canWrite: sql<boolean>`private.can_write_account(accounts.id)`,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    return row ?? null;
  });
}

/**
 * One account's whole statement screen (RF-129, RF-130): its header — name, kind,
 * institution, currency, the write privilege the policy would admit and the next
 * period's opening day — beside its recorded closes. TWO independent reads in ONE
 * `Promise.all`, never chained: the header and `listAccountStatements` each cost
 * their own round trip.
 *
 * Null when the account is absent or outside the caller's read scope.
 */
export async function getAccountStatementHistory(
  accountId: string,
): Promise<AccountStatementHistory | null> {
  const [account, statements] = await Promise.all([
    readStatementHistoryAccount(accountId),
    listAccountStatements(accountId),
  ]);

  if (account === null) return null;

  return { account, statements };
}
