import "server-only";

import { getAccountBalances } from "@/db/queries/account-balances";
import { listAccounts } from "@/db/queries/accounts";
import { listBudgetsWithStatus } from "@/db/queries/budgets";
import { countInboxPending } from "@/db/queries/ingest-review";
import { getMonthlyFlow } from "@/db/queries/reports/monthly-flow";
import { netWorthByOwner } from "@/db/queries/reports/net-worth";
import { withSharedTransaction } from "@/db/session";
import { BASE_CURRENCY, type CurrencyCode } from "@/lib/currency";
import { currentMonthRange } from "@/lib/dates";

// What the iPhone widget draws (RF-215): one currency, three figures, all integer cents. The widget is
// small, so the fund's other currencies stay on the dashboard.
export type WidgetSummary = {
  currency: CurrencyCode;
  // The dashboard's net worth in that currency: every readable account's derived balance, signed.
  disponible: { cents: number };
  // This month's expense (the dashboard's month flow) against the sum of the monthly budgets' limits
  // (the Presupuestos screen's), both in that currency.
  mes: { spentCents: number; budgetedCents: number };
  // Bandeja's own count (RF-200).
  bandeja: { pendingCount: number };
};

/**
 * The widget's read-model, in one fan-out like the dashboard's: the two aggregates keep a connection
 * each and the light reads share one, so the summary costs three transactions side by side, none
 * waiting on another. Scope is the policies' job, as for every screen: run it as the key's owner.
 */
export async function getWidgetSummary(): Promise<WidgetSummary> {
  const [balances, monthFlow, [accounts, budgets, pendingCount]] = await Promise.all([
    getAccountBalances(),
    getMonthlyFlow(currentMonthRange()),
    withSharedTransaction(() =>
      Promise.all([listAccounts({ archived: false }), listBudgetsWithStatus(), countInboxPending()]),
    ),
  ]);

  const totals = new Map<CurrencyCode, number>();
  for (const bucket of netWorthByOwner(accounts, balances)) {
    totals.set(bucket.currency, (totals.get(bucket.currency) ?? 0) + bucket.netWorthCents);
  }

  // The settlement currency when the fund holds it; otherwise the first in code order, as the dashboard lists them.
  const held = [...totals.keys()].sort();
  const currency = held.includes(BASE_CURRENCY) ? BASE_CURRENCY : (held[0] ?? BASE_CURRENCY);

  return {
    currency,
    disponible: { cents: totals.get(currency) ?? 0 },
    mes: {
      spentCents: monthFlow.find((flow) => flow.currency === currency)?.expenseCents ?? 0,
      budgetedCents: budgets
        .filter((budget) => budget.period === "monthly" && budget.currency === currency)
        .reduce((sum, budget) => sum + budget.limitCents, 0),
    },
    bandeja: { pendingCount },
  };
}
