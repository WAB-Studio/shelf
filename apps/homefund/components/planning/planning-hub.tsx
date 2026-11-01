import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { PLANNING_KEYS } from "@/components/fund/destinations";
import {
  Flex,
  Heading,
  Money,
  Mosaic,
  MosaicFigure,
  MosaicNote,
  MosaicTile,
  Progress,
  Ring,
  ScreenHeader,
  Text,
} from "@/components/ui";
import type { BudgetStatus } from "@/db/queries/budgets";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { GoalProgress } from "@/db/queries/savings-goals";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { formatMoney } from "@/lib/money";

/**
 * The Planeación hub: one card per area, each carrying a live one-line summary
 * derived on the server and a link into its screen. Its five areas and their
 * routes come from `destinations.ts`, the one file that lists them.
 */
export async function PlanningHub({
  budgetsSummary,
  goalsSummary,
  paymentsSummary,
  debtsSummary,
  recurringSummary,
  budgetsTop,
  budgetNames,
  goal,
  payments,
  debtsTotal,
  debtsNext,
}: {
  // The mosaic's own reads: the five fullest budgets, the first goal, the next
  // three payments and the debts line split into its figure and its next date.
  budgetsTop: BudgetStatus[];
  budgetNames: Map<string, string>;
  goal: GoalProgress | null;
  payments: PlannedPaymentRow[];
  debtsTotal: string;
  debtsNext: string | null;
  budgetsSummary: string;
  goalsSummary: string;
  paymentsSummary: string;
  debtsSummary: string;
  recurringSummary: string;
}) {
  const t = await getTranslations("planning");
  const format = await getFormatter();
  const locale = (await getLocale()) as Locale;
  const money = (cents: number, currency: string) =>
    formatMoney(cents, currency as CurrencyCode, locale);
  const shortDate = (date: string) =>
    format.dateTime(civilDateToDate(date), { day: "numeric", month: "short" });

  const titles: Record<(typeof PLANNING_KEYS)[number], string> = {
    budgets: t("budgetsTitle"),
    goals: t("goalsTitle"),
    payments: t("paymentsTitle"),
    debts: t("debtsTitle"),
    recurring: t("recurringTitle"),
  };
  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
      />

      <Mosaic>
          <MosaicTile href="/planning/budgets" size="large">
            <Heading as="h2" size="5">{titles.budgets}</Heading>
            <Text size="2" color="gray">{budgetsSummary}</Text>
            <Flex direction="column" gap="4" mt="2">
              {budgetsTop.map((budget) => {
                const pct = (budget.spentCents / budget.limitCents) * 100;
                const name = budget.name ?? budgetNames.get(budget.categoryId) ?? "";
                return (
                  <Flex key={budget.id} direction="column" gap="1">
                    <Flex justify="between" align="baseline" gap="3">
                      <Text size="3" weight="medium" truncate>{name}</Text>
                      <Text size="2" color={budget.overspent ? "red" : "gray"}>
                        {budget.overspent ? t("over") : `${Math.round(pct)}%`}
                      </Text>
                    </Flex>
                    <Progress
                      value={Math.min(100, pct)}
                      color={budget.overspent ? "red" : budget.overThreshold ? "amber" : undefined}
                      aria-label={name}
                    />
                    <Text size="2" color="gray">
                      {t("spentOf", {
                        spent: money(budget.spentCents, budget.currency),
                        limit: money(budget.limitCents, budget.currency),
                      })}
                    </Text>
                  </Flex>
                );
              })}
            </Flex>
          </MosaicTile>

          <MosaicTile href="/planning/goals" size="medium">
            <Heading as="h2" size="5">{titles.goals}</Heading>
            {goal ? (
              <Flex align="center" gap="4">
                <Ring value={goal.progressPct} aria-label={goal.name}>
                  <Text size="3" weight="bold">{goal.progressPct}%</Text>
                </Ring>
                <Flex direction="column" gap="1" minWidth="0">
                  <Text size="3" weight="medium" truncate>{goal.name}</Text>
                  <Text size="2" color="gray">
                    {goal.requiredMonthlyCents === null
                      ? t("goalLeft", { amount: money(goal.remainingCents, goal.currency) })
                      : t("goalLeftPace", {
                          amount: money(goal.remainingCents, goal.currency),
                          pace: money(goal.requiredMonthlyCents, goal.currency),
                        })}
                  </Text>
                </Flex>
              </Flex>
            ) : (
              <Text size="2" color="gray">{goalsSummary}</Text>
            )}
          </MosaicTile>

          <MosaicTile href="/planning/debts" size="medium" tone="ink">
            <Heading as="h2" size="5">{titles.debts}</Heading>
            <MosaicFigure>{debtsTotal}</MosaicFigure>
            <MosaicNote>{debtsNext ?? debtsSummary}</MosaicNote>
          </MosaicTile>

          <MosaicTile href="/planning/payments" size="wide">
            <Heading as="h2" size="5">{titles.payments}</Heading>
            {payments.length === 0 ? (
              <Text size="2" color="gray">{paymentsSummary}</Text>
            ) : (
              <Flex gap="5" wrap="wrap">
                {payments.map((payment) => (
                  <Flex key={payment.id} direction="column" gap="1" minWidth="0" flexBasis="0" flexGrow="1">
                    <Text size="2" color="gray">{shortDate(payment.dueDate)}</Text>
                    <Text size="3" weight="medium" truncate>
                      {payment.description ?? t("noConcept")}
                    </Text>
                    <Money
                      minor={payment.amountCents}
                      currency={payment.currency as CurrencyCode}
                      signed={false}
                    />
                  </Flex>
                ))}
              </Flex>
            )}
          </MosaicTile>

          <MosaicTile href="/planning/recurring" size="small">
            <Heading as="h2" size="5">{titles.recurring}</Heading>
            <Text size="2" color="gray">{recurringSummary}</Text>
          </MosaicTile>
      </Mosaic>

    </Flex>
  );
}
