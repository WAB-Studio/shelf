import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { PlanningHub } from "@/components/planning/planning-hub";
import { Page } from "@/components/ui";
import { listBudgetsWithStatus } from "@/db/queries/budgets";
import { getDebtsScreenData } from "@/db/queries/debts-screen";
import { listPlannedPayments } from "@/db/queries/planned-payments";
import { listRecurringRules } from "@/db/queries/recurring-rules";
import { listGoalsWithProgress } from "@/db/queries/savings-goals";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { civilDateToDate } from "@/lib/dates";
import { categoryNamesById } from "@/lib/fund/category-names";
import { nearestLimit, sumByCurrency } from "@/lib/fund/glance";
import { formatMoney } from "@/lib/money";
import { routing } from "@/i18n/routing";

export async function generateMetadata(
  props: PageProps<"/[locale]/planning">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "planning" });

  return { title: t("title") };
}

export default async function PlanningPage(
  props: PageProps<"/[locale]/planning">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const [budgets, goals, payments, debts, rules, options, t, format, tc] =
    await Promise.all([
      listBudgetsWithStatus(),
      listGoalsWithProgress(),
      listPlannedPayments({ status: "pending" }),
      getDebtsScreenData(),
      listRecurringRules(),
      getTransactionFormOptions(),
      getTranslations({ locale, namespace: "planning" }),
      getFormatter({ locale }),
      getTranslations({ locale, namespace: "categories" }),
    ]);

  const categoryNames = categoryNamesById(options.categories, (name) =>
    tc("scopedName", { name }),
  );

  // Every summary is derived here from the same reads the areas use; money is
  // formatted for display only, never re-stored, and cents stay integer. A
  // summary line holds one figure, so a hub that counts two currencies writes
  // one sentence per currency rather than adding them (RF-124); the currency's
  // own symbol is what says which movements each line counts.
  const budgetsSummary = sumByCurrency(budgets, (b) => [
    b.currency,
    [b.spentCents, b.limitCents],
  ])
    .map(([currency, [spentCents, limitCents]]) =>
      t("budgetsSummary", {
        count: budgets.filter((b) => b.currency === currency).length,
        spent: formatMoney(spentCents, currency, locale),
        limit: formatMoney(limitCents, currency, locale),
      }),
    )
    .join(" · ");

  const goalsSummary = sumByCurrency(goals, (g) => [g.currency, [g.savedCents]])
    .map(([currency, [savedCents]]) =>
      t("goalsSummary", {
        count: goals.filter((g) => g.currency === currency).length,
        saved: formatMoney(savedCents, currency, locale),
      }),
    )
    .join(" · ");

  // The list arrives soonest due first, so the head is the next pending payment.
  const soonest = payments[0];
  const paymentsSummary = soonest
    ? t("paymentsSummary", {
        concept: soonest.description ?? t("noConcept"),
        date: format.dateTime(civilDateToDate(soonest.dueDate), {
          day: "numeric",
          month: "short",
        }),
      })
    : t("paymentsEmpty");

  // Three states: no debts reads the empty line; a debt with a next payment names
  // its total and date; a debt without a due date names its total alone, since the
  // dated message cannot carry a missing date. The owed figures come already
  // struck per currency by `getDebtsScreenData` (RF-124), so the line names one
  // each and never the sum of two; the next payment is a single date, and stays
  // one whatever currencies stand beside it.
  //
  // `byCurrency` always carries the base currency, whether or not a debt bills in
  // it, so a set owing nothing is dropped — unless dropping it would leave the
  // line with no figure at all.
  const owing = debts.totals.byCurrency.filter((set) => set.owedCents !== 0);
  const total = (owing.length > 0 ? owing : debts.totals.byCurrency.slice(0, 1))
    .map((set) => formatMoney(set.owedCents, set.currency, locale))
    .join(" · ");
  const hasDebts = debts.withTerms.length > 0 || debts.withoutTerms.length > 0;
  const debtsSummary = !hasDebts
    ? t("debtsEmpty")
    : debts.totals.nextPayment !== null
      ? t("debtsSummary", {
          total,
          date: format.dateTime(
            civilDateToDate(debts.totals.nextPayment.date),
            { day: "numeric", month: "short" },
          ),
        })
      : t("debtsSummaryNoDate", { total });

  // The list arrives soonest next run first, so the head names the nearest rule.
  const nextRule = rules[0];
  const recurringSummary = nextRule
    ? t("recurringSummary", {
        count: rules.length,
        concept: nextRule.description ?? t("noConcept"),
        date: format.dateTime(civilDateToDate(nextRule.nextRunOn), {
          day: "numeric",
          month: "short",
        }),
      })
    : t("recurringEmpty");

  return (
    <Page>
      <PlanningHub
        budgetsSummary={budgetsSummary}
        goalsSummary={goalsSummary}
        paymentsSummary={paymentsSummary}
        debtsSummary={debtsSummary}
        recurringSummary={recurringSummary}
        budgetsTop={nearestLimit(budgets, 5)}
        budgetNames={categoryNames}
        goal={goals[0] ?? null}
        payments={payments.slice(0, 3)}
        debtsTotal={total}
        debtsNext={
          debts.totals.nextPayment !== null
            ? t("debtsNext", {
                date: format.dateTime(civilDateToDate(debts.totals.nextPayment.date), {
                  day: "numeric",
                  month: "short",
                }),
              })
            : null
        }
      />
    </Page>
  );
}
