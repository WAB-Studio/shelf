"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";

import {
  BarChart,
  Box,
  CategoryTile,
  EmptyState,
  Flex,
  Heading,
  ScreenHeader,
  Disc,
  Money,
  ProportionBar,
  ReportCard,
  ReportRow,
  Text,
  TextLink,
} from "@/components/ui";
import type { BarChartDatum } from "@/components/ui";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import type { MonthFlow } from "@/db/queries/reports/monthly-flow";
import type { ReportsData } from "@/db/queries/reports/reports-screen";
import type { MemberContributionNamed } from "@/db/queries/reports/reports-screen";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import { scopedCategoryName } from "@/lib/fund/category-names";
import { averageOfActive, categoryChartColor, shares } from "@/lib/fund/glance";
import type { Locale } from "@/lib/locales";
import { formatCompactMoney, formatMoney } from "@/lib/money";

// The two flow series carry the fund's colours: jade for what comes in, violet
// for what goes out. Red is kept for what was exceeded.
const SERIES_COLORS = {
  income: "var(--jade-9)",
  expense: "var(--violet-9)",
} as const;

// The title and the way into «Revisar el mes» (RF-155), on both faces.
function ReportsHead({ title }: { title: string }) {
  const t = useTranslations("review");
  return (
    <ScreenHeader
      title={title}
      actions={<TextLink href="/reports/review" size="2" weight="medium">{t("entry")}</TextLink>}
    />
  );
}

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
          <ReportsHead title={t("title")} />

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
          <ReportsHead title={t("title")} />

          <Flex direction="column" gap="4">
            <ReportCard>
              <Heading as="h2" size="4">{t("comparisonTitle")}</Heading>
              {byCurrency(sixMonthFlow).map(([currency, months]) => (
                <CurrencyTrend key={currency} currency={currency} months={months} />
              ))}
            </ReportCard>

            <ReportRow>
              <ReportCard>
                <Heading as="h2" size="4">{t("byCategoryTitle")}</Heading>
                <ExpenseBands expenses={expensesByCategory} months={sixMonthFlow} />
              </ReportCard>

              <ReportCard>
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
              </ReportCard>
            </ReportRow>
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
  const tKey = useTranslations();

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
    const percents = shares(rows.map((row) => row.totalCents));

    return (
      <Flex key={currency} direction="column" gap="3">
        <Text size="2" color="gray">
          {t("inCurrency", { currency })}
        </Text>
        {rows.map((row, index) => (
          <Flex key={row.categoryId} align="center" gap="3">
            <CategoryTile color={row.color} size={28} name={row.name} />
            <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
              <Flex justify="between" gap="3" align="baseline">
                <Text as="div" size="3" truncate>
                  {scopedCategoryName(row.name, row.scope, (name) =>
                    tKey("categories.scopedName", { name }),
                  )}
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
              <Flex align="center" gap="3">
                <Box flexGrow="1">
                  <ProportionBar
                    aria-label={t("shareLabel", { pct: percents[index] })}
                    segments={[
                      { key: row.categoryId, value: percents[index], color: categoryChartColor(row.color, row.categoryId) },
                    ]}
                    total={100}
                    height={8}
                  />
                </Box>
                <Text size="2" color="gray">{percents[index]}%</Text>
              </Flex>
            </Flex>
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
  const locale = useLocale() as Locale;

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

  // A window with nothing in it would draw axes and no bar.
  if (months.every((month) => month.incomeCents === 0 && month.expenseCents === 0)) {
    return (
      <EmptyState
        variant="filtered"
        title={t("comparisonEmpty")}
        description={t("comparisonEmptyHint", { currency })}
      />
    );
  }

  const average = averageOfActive(months.map((month) => month.expenseCents));
  const emptyMonths = months
    .filter((month) => month.incomeCents === 0 && month.expenseCents === 0)
    .map((month) => format.dateTime(civilDateToDate(month.monthStart), { month: "long" }));

  return (
    <Flex direction="column" gap="3">
      <BarChart
        data={chartData}
        seriesColors={SERIES_COLORS}
        formatValue={(cents) => formatCompactMoney(cents, currency, locale)}
        averageCents={average}
        averageLabel={
          average === null
            ? undefined
            : t("averageLabel", { amount: formatMoney(average, currency, locale) })
        }
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
      {emptyMonths.length > 0 && (
        <Text size="2" color="gray">
          {t("emptyMonths", { months: format.list(emptyMonths, { type: "conjunction" }) })}
        </Text>
      )}
    </Flex>
  );
}

// A colour dot beside its series name.
function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <Flex align="center" gap="2">
      <Disc size={12} surface={color} />
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
      <Box asChild flexGrow="1" minWidth="0">
        <Text as="div" size="3" truncate>
          {name}
        </Text>
      </Box>
      <Text size="3" weight="medium">
        <Money minor={row.contributionCents} currency={row.currency} size="inherit" />
      </Text>
    </Flex>
  );
}
