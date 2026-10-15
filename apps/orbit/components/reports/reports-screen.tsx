"use client";

import { useFormatter, useTranslations } from "next-intl";

import {
  BarChart,
  Box,
  CategoryTile,
  Flex,
  Heading,
  Money,
  Text,
} from "@/components/ui";
import type { BarChartDatum } from "@/components/ui";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import type { MonthFlow } from "@/db/queries/reports/monthly-flow";
import type { ReportsData } from "@/db/queries/reports/reports-screen";
import type { MemberContributionNamed } from "@/db/queries/reports/reports-screen";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import styles from "./reports-screen.module.css";

// The two flow series carry the fund's colours: jade for what comes in, tomato
// for what goes out.
const SERIES_COLORS = {
  income: "var(--jade-9)",
  expense: "var(--tomato-9)",
} as const;

/**
 * The reports screen: this month's expenses by category (largest first, RF-34),
 * the six-month income-vs-expense trend (RF-35) and each member's net contribution
 * to the group pot (RF-66) — the pot itself never a contributor (RF-67). Every
 * figure arrives already derived and stays an integer in the stored scale; the
 * reading is `Money`'s. Recharts lives behind the `BarChart` primitive alone.
 *
 * Every band on this screen is drawn once per currency and says which one it
 * counts (RF-124): two currencies are two breakdowns, two charts and two
 * contribution lists, and no series ever holds a bar from both.
 */
export function ReportsScreen({ data }: { data: ReportsData }) {
  const t = useTranslations("reports");

  const { expensesByCategory, sixMonthFlow, contributions, hasGroup } = data;

  return (
    <>
      {/* The phone's stack, unedited: category rows, chart, contributions, in
          that reading order. Hidden from `md` up, where the desktop row
          below takes over (RF-19). */}
      <Box display={{ initial: "block", md: "none" }}>
        <Flex direction="column" gap="6">
          <Heading size="6">{t("title")}</Heading>

          <Flex direction="column" gap="3" asChild>
            <section>
              <Heading as="h2" size="4">{t("byCategoryTitle")}</Heading>
              <ExpenseBands expenses={expensesByCategory} months={sixMonthFlow} />
            </section>
          </Flex>

          <Flex direction="column" gap="3" asChild>
            <section>
              <Heading as="h2" size="4">{t("comparisonTitle")}</Heading>
              {byCurrency(sixMonthFlow).map(([currency, months]) => (
                <CurrencyTrend key={currency} currency={currency} months={months} />
              ))}
            </section>
          </Flex>

          <Flex direction="column" gap="3" asChild>
            <section>
              <Heading as="h2" size="4">{t("contributionsTitle")}</Heading>
              {!hasGroup ? (
                <Text size="2" color="gray">
                  {t("noGroup")}
                </Text>
              ) : contributions.length === 0 ? (
                <Text size="2" color="gray">
                  {t("contributionsEmpty")}
                </Text>
              ) : (
                byCurrency(contributions).map(([currency, rows]) => (
                  <Flex key={currency} direction="column" gap="3">
                    <Text size="2" color="gray">
                      {t("inCurrency", { currency })}
                    </Text>
                    {rows.map((row) => (
                      <ContributionRow key={`${row.userId}|${row.currency}`} row={row} />
                    ))}
                  </Flex>
                ))
              )}
            </section>
          </Flex>
        </Flex>
      </Box>

      {/* The laptop's three cards: the trend full width, then category and
          contributions sharing a row. Same queries, same `CurrencyTrend` and
          `ContributionRow` the phone draws from — no figure is fetched twice
          and the chart keeps the props it always had (RF-34, RF-35, RF-66,
          RF-67). */}
      <Box display={{ initial: "none", md: "block" }}>
        <Flex direction="column" gap="6">
          <Heading size="6">{t("title")}</Heading>

          <Flex direction="column" gap="4">
            <div className={styles.card}>
              <Heading as="h2" size="4">{t("comparisonTitle")}</Heading>
              {byCurrency(sixMonthFlow).map(([currency, months]) => (
                <CurrencyTrend key={currency} currency={currency} months={months} />
              ))}
            </div>

            <div className={styles.lowerRow}>
              <div className={styles.card}>
                <Heading as="h2" size="4">{t("byCategoryTitle")}</Heading>
                <ExpenseBands expenses={expensesByCategory} months={sixMonthFlow} />
              </div>

              <div className={styles.card}>
                <Heading as="h2" size="4">{t("contributionsTitle")}</Heading>
                {!hasGroup ? (
                  <Text size="2" color="gray">
                    {t("noGroup")}
                  </Text>
                ) : contributions.length === 0 ? (
                  <Text size="2" color="gray">
                    {t("contributionsEmpty")}
                  </Text>
                ) : (
                  byCurrency(contributions).map(([currency, rows]) => (
                    <Flex key={currency} direction="column" gap="3">
                      <Text size="2" color="gray">
                        {t("inCurrency", { currency })}
                      </Text>
                      {rows.map((row) => (
                        <ContributionRow key={`${row.userId}|${row.currency}`} row={row} />
                      ))}
                    </Flex>
                  ))
                )}
              </div>
            </div>
          </Flex>
        </Flex>
      </Box>
    </>
  );
}

// Rows regrouped into the currencies they arrived in, each group keeping the
// order the query gave it. The one shape every band on this screen draws from:
// a group is what a figure, a bar or a legend counts, and two are never added.
function byCurrency<T extends { currency: CurrencyCode }>(
  rows: T[],
): [CurrencyCode, T[]][] {
  const groups = new Map<CurrencyCode, T[]>();
  for (const row of rows) {
    const group = groups.get(row.currency);
    if (group) group.push(row);
    else groups.set(row.currency, [row]);
  }

  return [...groups];
}

// The expenses by category, one band per currency, each closed by that
// currency's «Descuadre del mes» line when the month has one (RF-124). A currency
// whose only figure is its adjustment still gets a band to say what it counts.
function ExpenseBands({
  expenses,
  months,
}: {
  expenses: CategoryExpense[];
  months: MonthFlow[];
}) {
  const t = useTranslations("reports");

  // The window's last month per currency; the chart never draws the adjustment.
  const adjustments = new Map<CurrencyCode, MonthFlow>();
  for (const [currency, rows] of byCurrency(months)) {
    const last = rows[rows.length - 1];
    if (last && last.adjustmentCents !== 0) adjustments.set(currency, last);
  }

  const bands = new Map<CurrencyCode, CategoryExpense[]>(byCurrency(expenses));
  for (const currency of adjustments.keys()) {
    if (!bands.has(currency)) bands.set(currency, []);
  }

  if (bands.size === 0) {
    return (
      <Text size="2" color="gray">
        {t("byCategoryEmpty")}
      </Text>
    );
  }

  return [...bands].map(([currency, rows]) => {
    const adjustment = adjustments.get(currency);

    return (
      <Flex key={currency} direction="column" gap="3">
        <Text size="2" color="gray">
          {t("inCurrency", { currency })}
        </Text>
        {rows.map((row) => (
          <Flex key={row.categoryId} align="center" gap="3">
            <CategoryTile color={row.color} size={28} />
            <Text as="div" size="3" style={{ flex: 1, minWidth: 0 }} truncate>
              {row.name}
            </Text>
            <Text size="3" weight="medium">
              <Money
                minor={row.totalCents}
                currency={row.currency}
                signed={false}
                size="inherit"
              />
            </Text>
          </Flex>
        ))}
        {adjustment && (
          <Flex align="center" gap="3">
            <Box asChild flexGrow="1" minWidth="0">
              <Text as="div" size="3" truncate>
                {t("monthAdjustment")}
              </Text>
            </Box>
            <Text size="3" weight="medium">
              <Money
                minor={adjustment.adjustmentCents}
                currency={adjustment.currency}
                signed="always"
                size="inherit"
              />
            </Text>
          </Flex>
        )}
      </Flex>
    );
  });
}

// One currency's six-month trend: its own chart and its own legend, both naming
// the currency, so no bar is read against a figure from another one (RF-35,
// RF-124).
function CurrencyTrend({
  currency,
  months,
}: {
  currency: CurrencyCode;
  months: MonthFlow[];
}) {
  const t = useTranslations("reports");
  const format = useFormatter();

  const inCurrency = t("inCurrency", { currency });

  // Oldest-first months, each flat as the two-series shape the chart wants; the
  // label is the month's short name in the active locale.
  const chartData: BarChartDatum[] = months.map((month) => ({
    label: format.dateTime(civilDateToDate(month.monthStart), { month: "short" }),
    series: [
      { key: "income", valueCents: month.incomeCents },
      { key: "expense", valueCents: month.expenseCents },
    ],
  }));

  return (
    <Flex direction="column" gap="3">
      <BarChart
        data={chartData}
        seriesColors={SERIES_COLORS}
        aria-label={`${t("comparisonTitle")} ${inCurrency}`}
      />
      <Flex gap="4" wrap="wrap">
        <LegendItem
          color={SERIES_COLORS.income}
          label={`${t("legendIncome")} ${inCurrency}`}
        />
        <LegendItem
          color={SERIES_COLORS.expense}
          label={`${t("legendExpense")} ${inCurrency}`}
        />
      </Flex>
    </Flex>
  );
}

// A colour dot beside its series name.
function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <Flex align="center" gap="2">
      <Box
        style={{
          width: 12,
          height: 12,
          borderRadius: "9999px",
          background: color,
        }}
      />
      <Text size="2" color="gray">
        {label}
      </Text>
    </Flex>
  );
}

// One member's net contribution to the pot, in the currency the pot received;
// the caller's own row wears the self label when it carries no name.
function ContributionRow({ row }: { row: MemberContributionNamed }) {
  const t = useTranslations();

  const name = row.isSelf && row.name === null ? t("members.you") : row.name ?? t("members.you");

  return (
    <Flex align="center" gap="3">
      <Text as="div" size="3" style={{ flex: 1, minWidth: 0 }} truncate>
        {name}
      </Text>
      <Text size="3" weight="medium">
        <Money minor={row.contributionCents} currency={row.currency} size="inherit" />
      </Text>
    </Flex>
  );
}
