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
import { listRecurringCharges } from "@/db/queries/spending-patterns";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { civilDateToDate } from "@/lib/dates";
import { categoryNamesById } from "@/lib/fund/category-names";
import { nearestLimit, sumByCurrency } from "@/lib/fund/glance";
import { previewOf, upcomingItems } from "@/lib/fund/upcoming";
import { formatMoney } from "@/lib/money";
import { tagFigure } from "@/lib/privacy";
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


  // Another member's personal plan is not the caller's to summarise: the hub, like
  // Inicio, keeps their own and the fund's (RF-58). The areas below still list it, named.
  const mine = <T extends { foreignOwner: boolean }>(rows: T[]) =>
    rows.filter((row) => !row.foreignOwner);

  const [budgets, goals, payments, debts, rules, charges, options, t, format, tc] =
    await Promise.all([
      listBudgetsWithStatus().then(mine),
      listGoalsWithProgress().then(mine),
      listPlannedPayments({ status: "pending" }).then(mine),
      getDebtsScreenData({ withoutForeign: true }),
      listRecurringRules().then(mine),
      listRecurringCharges().then((rows) => rows.filter((row) => row.active)),
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
        spent: tagFigure(formatMoney(spentCents, currency, locale)),
        limit: tagFigure(formatMoney(limitCents, currency, locale)),
      }),
    )
    .join(" · ");

  const goalsSummary = sumByCurrency(goals, (g) => [g.currency, [g.savedCents]])
    .map(([currency, [savedCents]]) =>
      t("goalsSummary", {
        count: goals.filter((g) => g.currency === currency).length,
        saved: tagFigure(formatMoney(savedCents, currency, locale)),
      }),
    )
    .join(" · ");

  // One list of everything coming, soonest first; the tile names the head and shows the next three.
  const upcoming = upcomingItems({
    payments,
    rules,
    charges,
  });
  const soonest = upcoming[0] ? previewOf(upcoming[0]) : null;
  const upcomingSummary = soonest
    ? t("upcomingSummary", {
        concept: soonest.name ?? t("noConcept"),
        date: format.dateTime(civilDateToDate(upcoming[0].date), {
          day: "numeric",
          month: "short",
        }),
      })
    : t("upcomingEmpty");

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
    .map((set) => tagFigure(formatMoney(set.owedCents, set.currency, locale)))
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

  return (
    <Page>
      <PlanningHub
        budgetsSummary={budgetsSummary}
        goalsSummary={goalsSummary}
        upcomingSummary={upcomingSummary}
        debtsSummary={debtsSummary}
        budgetsTop={nearestLimit(budgets, 5)}
        budgetNames={categoryNames}
        goal={goals[0] ?? null}
        upcoming={upcoming.slice(0, 3)}
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
