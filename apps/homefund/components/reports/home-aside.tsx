import { useFormatter, useLocale, useTranslations } from "next-intl";

import {
  Badge,
  Card,
  Flex,
  Heading,
  Money,
  PlainLink,
  Progress,
  Text,
  TextLink,
} from "@/components/ui";
import type { BudgetStatus } from "@/db/queries/budgets";
import type { GoalProgress } from "@/db/queries/savings-goals";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";
import type { NextDebtPayment } from "@/lib/fund/glance";

/**
 * The desktop Inicio's right column under «Por pagar»: the budgets nearest their
 * limit, the goal furthest from its pace and the next debt payment. Each block is a
 * way into its screen and draws nothing when it has nothing to say. Every figure
 * arrives derived; the page names the rows it picked.
 */
export function HomeAside({
  budgets,
  budgetNames,
  goal,
  debt,
  debtName,
}: {
  budgets: BudgetStatus[];
  budgetNames: Map<string, string>;
  goal: GoalProgress | null;
  debt: NextDebtPayment | null;
  debtName: string | null;
}) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const locale = useLocale() as Locale;

  const shortDate = (date: string) =>
    format.dateTime(civilDateToDate(date), { day: "numeric", month: "short" });

  return (
    <>
      {budgets.length > 0 && (
        <Card>
          <Flex direction="column" gap="3">
            <Flex justify="between" align="baseline" gap="3">
              <Heading as="h2" size="4">{t("asideBudgets")}</Heading>
              <TextLink href="/planning/budgets" size="2" weight="medium">
                {t("asideBudgetsSee")}
              </TextLink>
            </Flex>
            {budgets.map((budget) => (
              <Flex key={budget.id} direction="column" gap="1">
                <Flex justify="between" align="baseline" gap="3">
                  <Text size="3" weight="medium" truncate>
                    {budget.name ?? budgetNames.get(budget.categoryId) ?? ""}
                  </Text>
                  {budget.overspent ? (
                    <Badge color="red" variant="soft" radius="full">{t("budgetOver")}</Badge>
                  ) : (
                    <Text size="2" color="gray">
                      {Math.round((budget.spentCents / budget.limitCents) * 100)}%
                    </Text>
                  )}
                </Flex>
                <Progress
                  value={Math.min(100, (budget.spentCents / budget.limitCents) * 100)}
                  color={budget.overspent ? "red" : budget.overThreshold ? "amber" : undefined}
                  aria-label={budget.name ?? budgetNames.get(budget.categoryId) ?? ""}
                />
                <Text size="2" color="gray">
                  {t("budgetSpent", {
                    spent: money(budget.spentCents, budget.currency),
                    limit: money(budget.limitCents, budget.currency),
                  })}
                </Text>
              </Flex>
            ))}
          </Flex>
        </Card>
      )}

      {goal && (
        <Card asChild>
          <PlainLink href="/planning/goals">
            <Flex direction="column" gap="2">
              <Heading as="h2" size="4">{t("asideGoal")}</Heading>
              <Flex justify="between" align="baseline" gap="3">
                <Text size="3" weight="medium" truncate>{goal.name}</Text>
                <Text size="2" color="gray">{goal.progressPct}%</Text>
              </Flex>
              <Progress
                value={goal.progressPct}
                color={goal.behindPace ? "amber" : undefined}
                aria-label={goal.name}
              />
              <Text size="2" color="gray">
                {goal.requiredMonthlyCents === null
                  ? t("goalLeft", { amount: money(goal.remainingCents, goal.currency) })
                  : t("goalLeftPace", {
                      amount: money(goal.remainingCents, goal.currency),
                      pace: money(goal.requiredMonthlyCents, goal.currency),
                    })}
              </Text>
            </Flex>
          </PlainLink>
        </Card>
      )}

      {debt && (
        <Card asChild>
          <PlainLink href={`/planning/debts/${debt.accountId}`}>
            <Flex direction="column" gap="1">
              <Heading as="h2" size="4">{t("asideDebt")}</Heading>
              <Flex justify="between" align="baseline" gap="3">
                <Text size="3" weight="medium" truncate>{debtName ?? ""}</Text>
                <Money
                  minor={debt.amountCents}
                  currency={debt.currency as CurrencyCode}
                  signed={false}
                />
              </Flex>
              <Text size="2" color="gray">{t("dueSoon", { date: shortDate(debt.date) })}</Text>
            </Flex>
          </PlainLink>
        </Card>
      )}
    </>
  );

  // Plain-text figure for a line that carries a sentence; a standalone amount
  // uses `Money`.
  function money(cents: number, currency: string): string {
    return formatMoney(cents, currency as CurrencyCode, locale);
  }
}
