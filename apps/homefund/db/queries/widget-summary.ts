import "server-only";

import { getAccountBalances } from "@/db/queries/account-balances";
import { listAccounts } from "@/db/queries/accounts";
import { listBudgetsWithStatus } from "@/db/queries/budgets";
import { countInboxPending } from "@/db/queries/ingest-review";
import { getMonthlyFlow } from "@/db/queries/reports/monthly-flow";
import { netWorthByOwner } from "@/db/queries/reports/net-worth";
import { listThirdPartyCredits } from "@/db/queries/third-party-credits";
import { withSharedTransaction } from "@/db/session";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { currentMonthRange, todayInBogota } from "@/lib/dates";
import { widgetCredit, type WidgetCredit } from "@/lib/widget/credit-item";
import { monthLeft, type MonthLeft } from "@/lib/widget/month-left";

// What the iPhone widget draws (RF-215): one currency, three figures, all integer cents. The widget is
// small, so the fund's other currencies stay on the dashboard.
export type WidgetSummary = {
  currency: CurrencyCode;
  // The money the person has: the derived balances of the readable bank and cash accounts, pockets included,
  // in that currency. Cards and loans stay out (that is net worth, which the dashboard shows), and so does
  // the «Me debe» account a credit somebody else pays is linked to (RF-211): that money is not in hand.
  disponible: { cents: number };
  // This month's expense (the dashboard's month flow) against the sum of the monthly budgets' limits
  // (the Presupuestos screen's), both in that currency.
  // `remainingCents` is budgeted minus spent and goes negative; `daysLeft` counts today; `perDayCents` is the
  // remainder over those days, floored, never below zero.
  mes: { spentCents: number; budgetedCents: number } & MonthLeft;
  // Bandeja's own count (RF-200).
  bandeja: { pendingCount: number };
  // One item per credit somebody else pays that the caller may read (RF-211), by the payer's name.
  creditos: WidgetCredit[];
};

/**
 * The widget's read-model, in one fan-out like the dashboard's: the two aggregates keep a connection
 * each and the light reads share one, so the summary costs three transactions side by side, none
 * waiting on another; the credits somebody else pays ride the shared one. Scope is the policies' job, as for every screen: run it as the key's owner.
 */
export async function getWidgetSummary(): Promise<WidgetSummary> {
  const today = todayInBogota();
  const [balances, monthFlow, [accounts, budgets, pendingCount, credits]] = await Promise.all([
    getAccountBalances(),
    getMonthlyFlow(currentMonthRange()),
    withSharedTransaction(() =>
      Promise.all([
        listAccounts({ archived: false }),
        listBudgetsWithStatus(),
        countInboxPending(),
        listThirdPartyCredits(),
      ]),
    ),
  ]);

  // The same account list and balance source as the dashboard's net worth, narrowed to what holds money.
  const receivables = new Set(credits.map((credit) => credit.receivableAccountId));
  const holdingMoney = accounts.filter(
    (account) =>
      account.kind === "asset" &&
      (account.subtype === "bank" || account.subtype === "cash") &&
      !receivables.has(account.id),
  );
  const totals = new Map<CurrencyCode, number>();
  for (const bucket of netWorthByOwner(holdingMoney, balances)) {
    totals.set(bucket.currency, (totals.get(bucket.currency) ?? 0) + bucket.netWorthCents);
  }

  // The settlement currency when the fund holds it; otherwise the first in code order, as the dashboard lists them.
  const held = [...totals.keys()].sort();
  const currency = held.includes(BASE_CURRENCY) ? BASE_CURRENCY : (held[0] ?? BASE_CURRENCY);

  const spentCents = monthFlow.find((flow) => flow.currency === currency)?.expenseCents ?? 0;
  const budgetedCents = budgets
    .filter((budget) => budget.period === "monthly" && budget.currency === currency)
    .reduce((sum, budget) => sum + budget.limitCents, 0);

  return {
    currency,
    disponible: { cents: totals.get(currency) ?? 0 },
    mes: { spentCents, budgetedCents, ...monthLeft(spentCents, budgetedCents, today) },
    bandeja: { pendingCount },
    creditos: credits.map((credit) => widgetCredit(credit, today)),
  };
}
