"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";

import { Card, EmptyState, Flex, Heading, Money, ScreenHeader, Text } from "@/components/ui";
import type { PersonCurrencyLedger } from "@/db/queries/owed-to-me";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import type { OwedLine } from "@/lib/owed-to-me";
import { useMoneyText } from "@/lib/use-privacy";

function Lines({ lines, currency, sign }: { lines: OwedLine[]; currency: CurrencyCode; sign: 1 | -1 }) {
  const t = useTranslations("owedToMe");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();

  return (
    <Flex direction="column">
      {lines.map((line, index) => (
        <Flex key={line.transactionId ?? index} align="center" justify="between" gap="4" py="2">
          <Flex direction="column" minWidth="0">
            <Text size="2" truncate>
              {line.description?.trim() || t("personNoDescription")}
            </Text>
            {line.occurredOn && (
              <Text size="1" color="gray">
                {format.dateTime(civilDateToDate(line.occurredOn), { day: "numeric", month: "short", year: "numeric" })}
              </Text>
            )}
          </Flex>
          <Text size="2" weight="medium">
            {moneyText(sign * line.cents, currency, locale)}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

/**
 * A person's page in Etiquetas: «Ya te debía $W desde <fecha> · gastaste $X para Carlos · te devolvió $Y · falta $Z»
 * with the two lists it is built from, one block per currency, leaving out any part that is zero (RF-319). The
 * figures arrive derived from movements; the sum reads only when the person is charged (RF-242).
 */
export function PersonScreen({ name, charged, ledgers }: { name: string; charged: boolean; ledgers: PersonCurrencyLedger[] }) {
  const t = useTranslations("owedToMe");
  const format = useFormatter();

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader title={t("personTitle", { name })} back={{ href: "/settings/labels", label: t("personBack") }} />
      {ledgers.length === 0 ? (
        <EmptyState title={t("personNothing", { name })} description={charged ? t("personHowToReturn", { name }) : undefined} />
      ) : (
        ledgers.map((ledger) => {
          const currency = ledger.currency as CurrencyCode;
          const money = (cents: number) => <Money minor={cents} currency={currency} tone="plain" size="inherit" signed={false} />;
          const when = ledger.openingSince ? format.dateTime(civilDateToDate(ledger.openingSince), { day: "numeric", month: "short", year: "numeric" }) : "";
          // A charged person reads as the parts that are not zero: what they already owed, what was spent, what came back, what is left.
          const parts: ((first: boolean) => ReactNode)[] = [];
          const first = (isFirst: boolean) => (isFirst ? "yes" : "no");
          if (ledger.openingCents > 0) parts.push(() => t.rich("personPartOpening", { date: when, amount: () => money(ledger.openingCents) }));
          if (ledger.spentCents > 0) parts.push((isFirst) => t.rich("personPartSpent", { name, first: first(isFirst), amount: () => money(ledger.spentCents) }));
          if (ledger.returnedCents > 0) parts.push((isFirst) => t.rich("personPartReturned", { first: first(isFirst), amount: () => money(ledger.returnedCents) }));
          parts.push(() => (ledger.owedCents > 0 ? t.rich("personPartOwed", { amount: () => money(ledger.owedCents) }) : t("personPartSettled")));
          const summary = charged
            ? parts.map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && " · "}
                  {part(index === 0)}
                </Fragment>
              ))
            : t.rich("personSummaryUncharged", { name, spent: () => money(ledger.spentCents) });
          return (
            <Card key={ledger.currency}>
              <Flex direction="column" gap="4">
                <Text size="3" weight="medium">
                  {summary}
                </Text>
                <Flex direction="column" gap="1">
                  <Heading as="h2" size="2">
                    {t("personSpentHeading", { name })}
                  </Heading>
                  <Lines lines={ledger.spent} currency={currency} sign={1} />
                </Flex>
                <Flex direction="column" gap="1">
                  <Heading as="h2" size="2">
                    {t("personReturnedHeading")}
                  </Heading>
                  {ledger.returned.length === 0 ? (
                    <Text size="2" color="gray">
                      {t("personNoReturns")}
                    </Text>
                  ) : (
                    <Lines lines={ledger.returned} currency={currency} sign={-1} />
                  )}
                  {charged && <Text size="1" color="gray">{t("personHowToReturn", { name })}</Text>}
                </Flex>
              </Flex>
            </Card>
          );
        })
      )}
    </Flex>
  );
}
