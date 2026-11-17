import { useFormatter, useTranslations } from "next-intl";

import { Card, Flex, Heading, Money, Text, TextLink } from "@/components/ui";
import type { HomeAhead } from "@/db/queries/home-lines";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import type { MonthlyFlow } from "@/db/queries/reports/monthly-flow";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { scopedCategoryName } from "@/lib/fund/category-names";
import { topWithRest } from "@/lib/fund/glance";

// How many categories the month's line names.
const TOP_CATEGORIES = 3;

// A figure drawn inside a translated sentence.
function figure(cents: number, currency: string) {
  const Figure = () => <Money minor={cents} currency={currency as CurrencyCode} size="inherit" signed={false} />;
  return Figure;
}

function useShortDate() {
  const format = useFormatter();
  return (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short" });
}

/**
 * Inicio's «Este mes pagas $X»: each card's statement total with its due date and its minimum in parentheses, then the
 * planned payments of the month, soonest first. A card with no statement of this month says its extract is missing.
 * The total never adds two currencies (RF-124).
 */
export function PaysLine({
  ahead,
  names,
}: {
  ahead: Pick<HomeAhead, "cards" | "loans" | "payments">;
  names: Record<string, string>;
}) {
  const t = useTranslations("dashboard");
  const shortDate = useShortDate();

  const rows = [
    ...ahead.cards.map((card) => ({ kind: "card" as const, key: card.accountId, dueDate: card.dueDate, card })),
    ...ahead.loans.map((loan) => ({ kind: "loan" as const, key: `${loan.accountId}:${loan.number ?? 0}`, dueDate: loan.dueDate, loan })),
    ...ahead.payments.map((payment) => ({ kind: "payment" as const, key: payment.id, dueDate: payment.dueDate, payment })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const totals = new Map<string, number>();
  for (const row of rows) {
    const [currency, cents] =
      row.kind === "card"
        ? [row.card.currency, row.card.totalCents ?? 0]
        : row.kind === "loan"
          ? [row.loan.currency, row.loan.amountCents]
          : [row.payment.currency, row.payment.amountCents];
    if (cents > 0) totals.set(currency, (totals.get(currency) ?? 0) + cents);
  }
  const missing = ahead.cards.some((card) => card.totalCents === null);

  return (
    <Card data-line="pays">
      <Flex direction="column" gap="2">
        {rows.length === 0 ? (
          <Text size="3" weight="medium">
            {t("paysNone")}
          </Text>
        ) : totals.size === 0 ? (
          <Heading as="h2" size="4">
            {t("paysTitleUnknown")}
          </Heading>
        ) : (
          [...totals]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, cents]) => (
              <Heading as="h2" size="4" key={currency}>
                {t.rich("paysTitle", { amount: figure(cents, currency) })}
              </Heading>
            ))
        )}

        {rows.map((row) =>
          row.kind === "card" ? (
            <TextLink key={row.key} href={`/planning/debts/${row.card.accountId}`} size="2" flow>
              {row.card.totalCents === null
                ? t("paysCardNoStatement", { name: names[row.card.accountId] ?? "", date: shortDate(row.dueDate) })
                : t.rich(row.card.minimumCents === null ? "paysCard" : "paysCardMinimum", {
                    name: names[row.card.accountId] ?? "",
                    amount: figure(row.card.totalCents, row.card.currency),
                    minimum: figure(row.card.minimumCents ?? 0, row.card.currency),
                    date: shortDate(row.dueDate),
                  })}
            </TextLink>
          ) : row.kind === "loan" ? (
            <TextLink key={row.key} href={`/planning/debts/${row.loan.accountId}`} size="2" flow>
              {t.rich(row.loan.number === null ? "paysPayment" : row.dueDate < todayInBogota() ? "paysLoanOverdue" : "paysLoan", {
                name: row.loan.name,
                number: row.loan.number ?? 0,
                amount: figure(row.loan.amountCents, row.loan.currency),
                date: shortDate(row.dueDate),
              })}
            </TextLink>
          ) : (
            <TextLink key={row.key} href="/planning/upcoming" size="2" flow>
              {t.rich("paysPayment", {
                name: row.payment.description ?? t("dueNoName"),
                amount: figure(row.payment.amountCents, row.payment.currency),
                date: shortDate(row.dueDate),
              })}
            </TextLink>
          ),
        )}

        {missing && (
          <Text size="2" color="gray">
            {t("paysMissing")}
          </Text>
        )}
      </Flex>
    </Card>
  );
}

/**
 * Inicio's «En noviembre gastaste $X», with the month's three largest categories under it, per currency (RF-124).
 * It reads the flow and the categories Inicio already has, so it costs no read of its own.
 */
export function SpentLine({
  month,
  flows,
  expenses,
}: {
  // The month the figures are for, as `YYYY-MM`.
  month: string;
  flows: MonthlyFlow[];
  expenses: CategoryExpense[];
}) {
  const t = useTranslations("dashboard");
  const tKey = useTranslations();
  const format = useFormatter();
  const monthName = format.dateTime(civilDateToDate(`${month}-01`), { month: "long" });
  const spent = flows.filter((flow) => flow.expenseCents > 0);

  return (
    <Card data-line="spent">
      <Flex direction="column" gap="2">
        {spent.length === 0 && (
          <Text size="3" weight="medium">
            {t("spentNone", { month: monthName })}
          </Text>
        )}

        {spent.map((flow) => {
          const { top } = topWithRest(
            expenses.filter((row) => row.currency === flow.currency),
            TOP_CATEGORIES,
          );

          return (
            <Flex key={flow.currency} direction="column" gap="1">
              <Heading as="h2" size="4">
                {t.rich("spentTitle", { month: monthName, amount: figure(flow.expenseCents, flow.currency) })}
              </Heading>
              {top.length > 0 && (
                <Flex gap="3" wrap="wrap">
                  {top.map((row) => (
                    <Text key={row.categoryId} size="2" color="gray">
                      {scopedCategoryName(row.name, row.scope, (name) => tKey("categories.fundMark", { name }))}{" "}
                      <Money minor={row.totalCents} currency={row.currency} size="inherit" signed={false} />
                    </Text>
                  ))}
                </Flex>
              )}
            </Flex>
          );
        })}

        <TextLink href="/reports" size="2" weight="medium">
          {t("spentSee")}
        </TextLink>
      </Flex>
    </Card>
  );
}

/**
 * Inicio's «Viene»: the next income expected and the next bill, from the pending planned payments. Nothing when
 * neither is on the books.
 */
export function AheadLine({ ahead }: { ahead: Pick<HomeAhead, "nextIncome" | "nextBill"> }) {
  const t = useTranslations("dashboard");
  const shortDate = useShortDate();
  const { nextIncome, nextBill } = ahead;
  if (!nextIncome && !nextBill) return null;

  return (
    <Card data-line="ahead">
      <Flex direction="column" gap="2">
        <Heading as="h2" size="4">
          {t("aheadTitle")}
        </Heading>
        {nextIncome && (
          <TextLink href="/planning/upcoming" size="2" flow>
            {t.rich("aheadIncome", {
              amount: figure(nextIncome.amountCents, nextIncome.currency),
              name: nextIncome.description ?? t("dueNoName"),
              date: shortDate(nextIncome.dueDate),
            })}
          </TextLink>
        )}
        {nextBill && (
          <TextLink href="/planning/upcoming" size="2" flow>
            {t.rich("aheadBill", {
              name: nextBill.description ?? t("dueNoName"),
              amount: figure(nextBill.amountCents, nextBill.currency),
              date: shortDate(nextBill.dueDate),
            })}
          </TextLink>
        )}
      </Flex>
    </Card>
  );
}
