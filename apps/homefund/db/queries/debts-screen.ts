import "server-only";

import { getAccountBalances } from "@/db/queries/account-balances";
import { listAccounts } from "@/db/queries/accounts";
import { getDebtOverview, sumDebtCreditTotals } from "@/db/queries/debt-overview";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import { listPlanPositions } from "@/db/queries/installment-plans";
import type { PlanPosition } from "@/db/queries/installment-plans";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";

// One consolidated set, in one currency. Every figure in it is denominated in
// `currency` and none of them counts a movement, a limit or a rate booked in
// another one (RF-124).
export type DebtCurrencyTotals = {
  currency: CurrencyCode;
  // The debts owing in this currency, which is not the fund's debt count: a card
  // that bills in pesos and buys in dollars is one of each.
  debtCount: number;
  owedCents: number;
  monthlyInterestCents: number;
  // The share of the owed magnitude the summed interest is charged at, the one
  // definition of the consolidated rate: no screen divides the two totals.
  monthlyRatePct: number;
  // Null when no debt billing in this currency carries a limit, which is not the
  // same as a cupo spent down to zero (RF-117).
  availableCreditCents: number | null;
  creditLimitCents: number | null;
};

export type DebtsScreenData = {
  totals: DebtCurrencyTotals & {
    // One set per currency the fund's debts hold, the base currency first and
    // always present, then the rest in currency order. The flat figures above
    // ARE that first set — the base currency's, never a sum across the vector.
    byCurrency: DebtCurrencyTotals[];
    nextPayment: {
      accountId: string;
      amountCents: number;
      // What the paying debt bills in, so the figure is drawn in it.
      currency: CurrencyCode;
      date: string;
      name: string;
    } | null;
  };
  withTerms: (DebtOverviewRow & {
    name: string;
    planPosition: PlanPosition | null;
    canWrite: boolean;
  })[];
  withoutTerms: {
    accountId: string;
    name: string;
    // The same pair the overview carries: the pocket the debt settles in, and
    // the ones it does not (RF-121).
    currency: CurrencyCode;
    owedCents: number;
    otherOwed: DebtPocket[];
    planPosition: PlanPosition | null;
    canWrite: boolean;
  }[];
  payFrom: { id: string; name: string; balanceCents: number }[];
};

// The set a currency starts at, so a currency the fund holds nothing in still
// reads as a zero rather than as nothing.
function emptyTotals(currency: CurrencyCode): DebtCurrencyTotals {
  return {
    currency,
    debtCount: 0,
    owedCents: 0,
    monthlyInterestCents: 0,
    monthlyRatePct: 0,
    availableCreditCents: null,
    creditLimitCents: null,
  };
}

// Adds one debt's pocket onto the running sets, one currency at a time. The
// settlement pocket carries the interest it is charged; a pocket in another
// currency carries a magnitude and nothing else, since a rate is written into
// the terms of the currency the card bills in (RF-79, RF-124).
function addOwed(
  sets: Map<CurrencyCode, DebtCurrencyTotals>,
  currency: CurrencyCode,
  owedCents: number,
  monthlyInterestCents: number,
): void {
  const totals = sets.get(currency) ?? emptyTotals(currency);

  sets.set(currency, {
    ...totals,
    debtCount: totals.debtCount + 1,
    owedCents: totals.owedCents + owedCents,
    monthlyInterestCents: totals.monthlyInterestCents + monthlyInterestCents,
  });
}

/**
 * Everything the debts screen renders, in ONE fan-out of four existing reads
 * (RF-83, RF-117, RNF-09): the terms-carrying overview, the account roster for
 * names, the kind partition and what the caller may write, the derived balances
 * for the no-terms owed magnitudes, and each account's installment position. The
 * awaits never chain — four round trips, no more. Every figure arrives already
 * derived from the backend and stays integer cents.
 *
 * The totals come out one set per currency (RF-124): a card that bills in pesos
 * and buys in dollars owes in both, and there is no single number for what it
 * owes. Every set is labelled by the screen and no figure crosses two of them.
 */
export async function getDebtsScreenData(): Promise<DebtsScreenData> {
  const [overview, accounts, balances, positions] = await Promise.all([
    getDebtOverview(),
    listAccounts({ archived: false }),
    getAccountBalances(),
    listPlanPositions(),
  ]);

  const nameById = new Map(accounts.map((account) => [account.id, account.name]));
  // The roster's own projection carries the write privilege, so no debt costs a
  // second statement to learn what its caller may do to it.
  const writableById = new Map(
    accounts.map((account) => [account.id, account.canWrite]),
  );
  // The view answers one row per account AND currency, so the key is the pair:
  // keyed by the account alone, the last currency read would win and a card's
  // peso balance would report whatever its dollar pocket happened to hold.
  const balanceByPocket = new Map(
    balances.map((balance) => [
      `${balance.accountId}:${balance.currency}`,
      balance.balanceCents,
    ]),
  );
  const positionById = new Map(
    positions.map((position) => [position.accountId, position]),
  );

  // The overview holds the liabilities that carry terms (RF-78), archived ones
  // included — its join filters only by kind. An archived account is off the
  // active roster, so it drops here and stays out of the totals below.
  const withTerms = overview.flatMap((row) => {
    const name = nameById.get(row.accountId);
    if (name === undefined) return [];

    return [
      {
        ...row,
        name,
        planPosition: positionById.get(row.accountId) ?? null,
        // Absent from the roster is a debt the caller may not write.
        canWrite: writableById.get(row.accountId) ?? false,
      },
    ];
  });

  // A liability absent from the overview owes without a rate (RF-78, RF-79); its
  // owed is the magnitude of the derived balance, never a stored figure, read in
  // the pocket it settles in and with its other pockets beside it. It may still
  // carry a plan, so its position is looked up the same way.
  const withTermsIds = new Set(withTerms.map((row) => row.accountId));
  const withoutTerms = accounts
    .filter((account) => account.kind === "liability" && !withTermsIds.has(account.id))
    .map((account) => ({
      accountId: account.id,
      name: account.name,
      currency: account.settlementCurrency,
      owedCents: Math.abs(
        balanceByPocket.get(`${account.id}:${account.settlementCurrency}`) ?? 0,
      ),
      otherOwed: account.balances
        .filter((balance) => balance.currency !== account.settlementCurrency)
        .map((balance) => ({
          currency: balance.currency,
          owedCents: Math.abs(balance.balanceCents),
        })),
      planPosition: positionById.get(account.id) ?? null,
      canWrite: account.canWrite,
    }));

  // Every pocket of every debt, folded into the set of the currency it is
  // denominated in. A no-terms debt has no rate, so only the overview rows
  // contribute interest (RF-79), and only their settlement pocket does: the
  // terms are written against the currency the card bills in.
  const sets = new Map<CurrencyCode, DebtCurrencyTotals>();
  for (const row of withTerms) {
    addOwed(sets, row.currency, row.owedCents, row.monthlyInterestCents);
    for (const pocket of row.otherOwed) {
      addOwed(sets, pocket.currency, pocket.owedCents, 0);
    }
  }
  for (const debt of withoutTerms) {
    addOwed(sets, debt.currency, debt.owedCents, 0);
    for (const pocket of debt.otherOwed) {
      addOwed(sets, pocket.currency, pocket.owedCents, 0);
    }
  }

  // Exactly the debts that carry a limit (RF-117), one set per currency: one
  // without a limit is skipped rather than counted as a zero, so it neither
  // lifts a summed limit nor drags a summed available down.
  for (const credit of sumDebtCreditTotals(withTerms)) {
    const totals = sets.get(credit.currency) ?? emptyTotals(credit.currency);
    sets.set(credit.currency, {
      ...totals,
      availableCreditCents: credit.availableCreditCents,
      creditLimitCents: credit.creditLimitCents,
    });
  }

  // The base currency always answers, whether or not a debt settles in it: the
  // fund is kept in it, so its set is the one the flat figures below read and a
  // fund with no debt at all still states a zero rather than nothing.
  if (!sets.has(BASE_CURRENCY)) sets.set(BASE_CURRENCY, emptyTotals(BASE_CURRENCY));

  // The base currency first, the rest in currency order: the head of the vector
  // is what the flat figures read, so it has to be the same set every time.
  const byCurrency = [...sets.values()]
    .sort((left, right) => {
      if (left.currency === BASE_CURRENCY) return -1;
      if (right.currency === BASE_CURRENCY) return 1;
      return left.currency.localeCompare(right.currency);
    })
    .map((totals) => ({
      ...totals,
      // The share of the owed magnitude the interest above is charged at, struck
      // over the whole debt in this currency — the no-terms debts included, since
      // they are in the total the tile sits under. Derived once here so no screen
      // divides two totals of its own.
      monthlyRatePct:
        totals.owedCents > 0 ? totals.monthlyInterestCents / totals.owedCents : 0,
    }));

  // The earliest named due date carries the consolidated next payment (RF-83):
  // that row's minimum plus the installments falling due by then, the currency it
  // bills in, and the debt it belongs to — its id as well as its name, so the row
  // that carries the badge is named rather than matched back by hand.
  const nextPayment = withTerms
    .filter((row): row is typeof row & { nextDueDate: string } => row.nextDueDate !== null)
    .reduce<DebtsScreenData["totals"]["nextPayment"]>((earliest, row) => {
      if (earliest !== null && earliest.date <= row.nextDueDate) return earliest;
      return {
        accountId: row.accountId,
        amountCents: (row.minimumPaymentCents ?? 0) + row.dueInstallmentsCents,
        currency: row.currency,
        date: row.nextDueDate,
        name: row.name,
      };
    }, null);

  // A debt is paid from an asset (RF-16), so the source picker is filtered out of
  // the roster already read — never a fifth round trip, and never a liability.
  const payFrom = accounts
    .filter((account) => account.kind === "asset")
    .map((account) => ({
      id: account.id,
      name: account.name,
      // What the source settles in, never a sum across the currencies it holds
      // (RF-124). The roster orders the settlement pocket first.
      balanceCents: account.balances[0]?.balanceCents ?? 0,
    }));

  return {
    totals: { ...byCurrency[0], byCurrency, nextPayment },
    withTerms,
    withoutTerms,
    payFrom,
  };
}
