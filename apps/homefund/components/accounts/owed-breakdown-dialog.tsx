"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";

import { useMovementEntry } from "@/components/transactions/movement-entry-provider";
import { Button, Dialog, Flex, Money, Separator, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import type { OwedLine, OwedPerson } from "@/lib/owed-to-me";
import { useMoneyText } from "@/lib/use-privacy";

/**
 * Where a person's figure comes from. A friend «se le cobra»: line by line, what grew it and what shrank it, then
 * «Falta». A credit somebody else pays: the capital the loan still owes, what the bank says is left, and, with a
 * payment schedule, what the unpaid cuotas ask with interest. The lines arrive derived from movements and sum to
 * the figure, so nothing is added up here.
 */
export function OwedBreakdownDialog({ person, onOpenChange }: { person: OwedPerson; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("owedToMe");
  const { openReturn } = useMovementEntry();
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const currency = person.currency as CurrencyCode;
  const day = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short", year: "numeric" });

  function label(line: OwedLine): string {
    const date = line.occurredOn ? day(line.occurredOn) : "";
    const description = line.description?.trim();
    switch (line.kind) {
      case "capital":
        return t("breakdownCapital");
      case "spent":
        return description ? t("breakdownSpentNamed", { date, description }) : t("breakdownSpent", { date });
      case "returned":
        return description ? t("breakdownReturnedNamed", { date, description }) : t("breakdownReturned", { date });
    }
  }

  const credit = person.source === "credit";

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("breakdownTitle", { person: person.name })}</Dialog.Title>
        {credit && (
          <Text as="p" size="2" color="gray" mb="3">
            {t("breakdownCreditHow", { person: person.name })}
          </Text>
        )}
        <Flex direction="column">
          {person.breakdown.map((line, index) => (
            <Flex key={`${line.kind}-${line.transactionId ?? index}`} align="center" justify="between" gap="4" py="2">
              <Text size="2">{label(line)}</Text>
              <Text size="2" weight="medium">
                {moneyText(line.cents, currency, locale)}
              </Text>
            </Flex>
          ))}
          {person.withInterest !== null && (
            <Text as="p" size="2" color="gray" mt="2">
              {t("withInterest", { amount: moneyText(person.withInterest.cents, currency, locale), count: person.withInterest.count })}
            </Text>
          )}
          {!credit && (
            <>
              <Separator size="4" />
              <Flex align="center" justify="between" gap="4" py="3">
                <Text size="3" weight="bold">
                  {t("breakdownOwes")}
                </Text>
                <Text size="3" weight="bold">
                  <Money minor={person.cents} currency={currency} signed={false} size="inherit" />
                </Text>
              </Flex>
            </>
          )}
        </Flex>
        <Flex justify="end" gap="3" mt="4">
          {/* Only a friend «se le cobra» pays back by an income; a credit somebody else pays is paid to the bank. */}
          {!credit && person.labelId !== null && (
            <Button
              type="button"
              onClick={() => {
                const labelId = person.labelId as string;
                onOpenChange(false);
                openReturn(labelId);
              }}
            >
              {t("breakdownRegisterPayment")}
            </Button>
          )}
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray">
              {t("breakdownClose")}
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
