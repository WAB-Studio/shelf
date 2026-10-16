import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { listAccountStatements } from "@/db/queries/account-statements";
import type { AccountStatementRow } from "@/db/queries/account-statements";
import {
  getCurrentStatement,
  listPendingSettlements,
} from "@/db/queries/debt-statements";
import type {
  CurrentStatement,
  PendingSettlement,
} from "@/db/queries/debt-statements";
import { getUserGroup } from "@/db/queries/groups";
import { listPlansForAccount } from "@/db/queries/installment-plans";
import type { InstallmentPlanRow } from "@/db/queries/installment-plans";
import { accounts, debtTerms } from "@/db/schema";
import type { Account, DebtTerms } from "@/db/schema";
import { withUserDb } from "@/db/session";

// One pocket of the account: the view derives a figure per currency and no
// surface sums two of them (RF-124).
export type AccountBalance = { currency: string; balanceCents: number };

export type DebtDetailAccount = {
  id: string;
  name: string;
  subtype: Account["subtype"];
  institution: string | null;
  // The currency the card bills in, which the cupo, the minimum and the interest
  // are read in (RF-121).
  settlementCurrency: string;
  // The settlement pocket, the one figure the terms are measured against.
  balanceCents: number;
  // Every pocket the account holds, the settlement one first.
  balances: AccountBalance[];
  archivedAt: Date | null;
};

export type DebtDetailData = {
  account: DebtDetailAccount;
  terms: DebtTerms | null;
  plans: InstallmentPlanRow[];
  statements: AccountStatementRow[];
  currentStatement: CurrentStatement | null;
  // The foreign-currency purchases the issuer has not billed yet (RF-123).
  pendingSettlements: PendingSettlement[];
  // What the policies would admit, so the screen offers no action the database
  // would refuse.
  canWrite: boolean;
  payFrom: { id: string; name: string; balanceCents: number }[];
  hasGroup: boolean;
};

type AccountRead = {
  account: DebtDetailAccount;
  terms: DebtTerms | null;
  canWrite: boolean;
  payFrom: DebtDetailData["payFrom"];
} | null;

/**
 * The liability itself in ONE round trip: its row with the balance the
 * `account_balances` view derives (RNF-07), its optional `debt_terms`, whether the
 * caller may write it, and the active asset roster a payment picks its source from
 * (RF-16) — the roster rides along as a `jsonb_agg` rather than a second read.
 * Null when the row is absent, is not a liability, or the policies did not show it.
 */
async function readAccount(accountId: string): Promise<AccountRead> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select({
        id: accounts.id,
        name: accounts.name,
        subtype: accounts.subtype,
        institution: accounts.institution,
        archivedAt: accounts.archivedAt,
        settlementCurrency: accounts.settlementCurrency,
        balanceCents: sql<string>`b.balance_cents`,
        // Written with the column's own name, never a Drizzle column reference: a
        // reference inside a projection fragment renders bare and binds inward.
        canWrite: sql<boolean>`private.can_write_account(accounts.id)`,
        // Every pocket, the settlement one first: a card that buys in dollars and
        // bills in pesos holds two, and the screen names each one (RF-124).
        balances: sql<AccountBalance[]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'currency', ab.currency, 'balanceCents', ab.balance_cents
          ) order by (ab.currency = accounts.settlement_currency) desc, ab.currency)
          from account_balances ab
          where ab.id = accounts.id
        ), '[]'::jsonb)`,
        // An asset pays a debt out of the currency it settles in; its other
        // pockets are not what a payment comes from (RF-16).
        payFrom: sql<DebtDetailData["payFrom"]>`coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', x.id, 'name', x.name, 'balanceCents', xb.balance_cents
          ) order by x.name)
          from accounts x
          join account_balances xb
            on xb.id = x.id and xb.currency = x.settlement_currency
          where x.kind = 'asset' and x.archived_at is null
        ), '[]'::jsonb)`,
        terms: debtTerms,
      })
      .from(accounts)
      // The view derives one row per account and currency from movements, never a
      // stored column, and runs `security_invoker`: the join drops nothing the
      // account policy already showed. Bounded to the settlement pocket, or the
      // row would come back once per currency the card holds.
      .innerJoin(
        sql`account_balances b`,
        sql`b.id = ${accounts.id} and b.currency = ${accounts.settlementCurrency}`,
      )
      .leftJoin(debtTerms, eq(debtTerms.accountId, accounts.id))
      .where(and(eq(accounts.id, accountId), eq(accounts.kind, "liability")))
      .limit(1);

    if (!row) return null;

    return {
      account: {
        id: row.id,
        name: row.name,
        subtype: row.subtype,
        institution: row.institution,
        settlementCurrency: row.settlementCurrency,
        // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
        balanceCents: Number(row.balanceCents),
        balances: row.balances,
        archivedAt: row.archivedAt,
      },
      terms: row.terms,
      canWrite: row.canWrite,
      payFrom: row.payFrom,
    };
  });
}

/**
 * One debt's whole detail (RF-16, RF-81, RF-82, RF-84, RNF-09): the account with
 * its derived balance and terms, its installment plans with their lines and
 * pending, its closed statements, the open period's live figures, the purchases
 * still waiting for a statement (RF-123), and the roster a payment is made from.
 * Six independent reads in ONE `Promise.all` — nothing chains.
 *
 * The statements are the closes a person recorded, each carrying the gap between
 * what it printed and what the movements derive (RF-129). None is generated here.
 *
 * Null is one shape for three refusals — absent, not a liability, or outside the
 * caller's read scope — which a route turns into `notFound()`. Every figure
 * derives except the statement snapshots, the one persisted balance figure, read
 * as stored.
 */
export async function getDebtDetail(
  accountId: string,
): Promise<DebtDetailData | null> {
  const [read, plans, statements, currentStatement, pendingSettlements, group] =
    await Promise.all([
      readAccount(accountId),
      listPlansForAccount(accountId),
      listAccountStatements(accountId),
      getCurrentStatement(accountId),
      listPendingSettlements(accountId),
      getUserGroup(),
    ]);

  if (read === null) return null;

  return {
    account: read.account,
    terms: read.terms,
    plans,
    statements,
    currentStatement,
    pendingSettlements,
    canWrite: read.canWrite,
    payFrom: read.payFrom,
    hasGroup: group !== null,
  };
}
