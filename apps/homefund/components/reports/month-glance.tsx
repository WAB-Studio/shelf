import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  Card,
  Disc,
  Flex,
  Heading,
  Money,
  ProportionBar,
  Text,
} from "@/components/ui";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import type { MonthlyFlow } from "@/db/queries/reports/monthly-flow";
import { chartColor, shares, topWithRest } from "@/lib/fund/glance";
import { scopedCategoryName } from "@/lib/fund/category-names";

// Income reads jade and spending violet on every chart; red is only for what was
// exceeded (DESIGN.md).
const INCOME = "var(--jade-9)";
const SPENDING = "var(--violet-9)";
const REST = "var(--gray-8)";
// How many categories get a segment of their own before the rest folds together.
const SEGMENTS = 4;

/**
 * Inicio's month at a glance, per currency: how much of what came in went out,
 * and which categories took it. The two bars read the same figures the month
 * card above prints, so none is fetched twice and no currency is added to another
 * (RF-124).
 */
export function MonthGlance({
  flows,
  expenses,
}: {
  flows: MonthlyFlow[];
  expenses: CategoryExpense[];
}) {
  const t = useTranslations("dashboard");
  const tKey = useTranslations();

  const active = flows.filter((flow) => flow.incomeCents > 0 || flow.expenseCents > 0);
  if (active.length === 0) return null;

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Heading as="h2" size="4">{t("glanceTitle")}</Heading>

        {active.map((flow) => {
          const rows = expenses.filter((row) => row.currency === flow.currency);
          const { top, restCents } = topWithRest(rows, SEGMENTS);
          const parts = [
            ...top.map((row) => ({
              key: row.categoryId,
              label: scopedCategoryName(row.name, row.scope, (name) =>
                tKey("categories.scopedName", { name }),
              ),
              cents: row.totalCents,
              color: chartColor(row.categoryId),
            })),
            ...(restCents > 0
              ? [{ key: "rest", label: t("glanceOthers"), cents: restCents, color: REST }]
              : []),
          ];
          const pct = shares(parts.map((part) => part.cents));
          const spentPct =
            flow.incomeCents > 0
              ? Math.round((flow.expenseCents / flow.incomeCents) * 100)
              : null;

          return (
            <Flex key={flow.currency} direction="column" gap="4">
              <Flex direction="column" gap="2">
                <ProportionBar
                  aria-label={t("glanceMeterLabel", { currency: flow.currency })}
                  segments={[{ key: "spent", value: flow.expenseCents, color: SPENDING }]}
                  total={flow.incomeCents}
                  height={14}
                />
                <Flex justify="between" gap="3" wrap="wrap">
                  <Legend color={INCOME} label={t("glanceIncome")}>
                    <Money minor={flow.incomeCents} currency={flow.currency} size="inherit" />
                  </Legend>
                  <Legend color={SPENDING} label={t("glanceSpending")}>
                    <Money
                      minor={flow.expenseCents}
                      currency={flow.currency}
                      signed={false}
                      size="inherit"
                    />
                  </Legend>
                </Flex>
                <Text size="2" color="gray">
                  {spentPct === null ? t("glanceNoIncome") : t("glanceSpentOf", { pct: spentPct })}
                </Text>
              </Flex>

              {parts.length > 0 && (
                <Flex direction="column" gap="2">
                  <ProportionBar
                    aria-label={t("glanceByCategory")}
                    segments={parts.map((part) => ({
                      key: part.key,
                      value: part.cents,
                      color: part.color,
                    }))}
                    height={14}
                  />
                  <Flex gap="3" wrap="wrap">
                    {parts.map((part, index) => (
                      <Legend key={part.key} color={part.color} label={part.label}>
                        {pct[index]}%
                      </Legend>
                    ))}
                  </Flex>
                </Flex>
              )}
            </Flex>
          );
        })}
      </Flex>
    </Card>
  );
}

// A colour dot, the name it stands for and its figure.
function Legend({
  color,
  label,
  children,
}: {
  color: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Flex align="center" gap="2">
      <Disc size={10} surface={color} />
      <Text size="2" color="gray">{label}</Text>
      <Text size="2" weight="medium">{children}</Text>
    </Flex>
  );
}
