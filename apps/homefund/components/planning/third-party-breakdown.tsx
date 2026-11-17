"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";

import { readThirdPartyCreditAction } from "@/app/actions/third-party-credits";
import { Button, Dialog, Flex, Money, Separator, Spinner, Text } from "@/components/ui";
import type { ThirdPartyCreditView } from "@/db/queries/third-party-credits";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { useMoneyText } from "@/lib/use-privacy";

type Breakdown = Pick<
  ThirdPartyCreditView,
  "personName" | "openingCents" | "openedOn" | "payments" | "otherCents" | "personOwesCents" | "schedule"
>;

/**
 * How «le falta» is built (RF-262): what the payer owed the day the credit was followed, each transfer they sent
 * with its day and amount, and what is left. Every figure arrives derived from movements; none is summed here but
 * the line that names the difference, when the balance holds more than the opening less the payments.
 */
function BreakdownBody({ credit, currency }: { credit: Breakdown; currency: CurrencyCode }) {
  const t = useTranslations("thirdPartyCredit");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const { personName: person, schedule } = credit;
  const day = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short", year: "numeric" });
  const money = (cents: number) => <Money minor={cents} currency={currency} signed={false} size="inherit" />;

  return (
    <Flex direction="column" gap="3">
      <Flex direction="column">
        <Flex align="center" justify="between" gap="4" py="2">
          <Text size="2">{t("breakdownOpening", { date: day(credit.openedOn) })}</Text>
          <Text size="2" weight="medium">
            {money(credit.openingCents)}
          </Text>
        </Flex>
        <Separator size="4" />
        <Text size="2" color="gray" mt="3">
          {t("breakdownPayments", { person })}
        </Text>
        {credit.payments.length === 0 ? (
          <Flex py="2">
            <Text size="2">{t("breakdownNoPayments", { person })}</Text>
          </Flex>
        ) : (
          credit.payments.map((payment, index) => (
            <Flex key={`${payment.occurredOn}-${index}`} align="center" justify="between" gap="4" py="2">
              <Text size="2">{day(payment.occurredOn)}</Text>
              <Text size="2" weight="medium">
                {moneyText(-payment.amountCents, currency, locale)}
              </Text>
            </Flex>
          ))
        )}
        {credit.otherCents !== 0 && (
          <Flex align="center" justify="between" gap="4" py="2">
            <Text size="2">{t("breakdownOther")}</Text>
            <Text size="2" weight="medium">
              {moneyText(credit.otherCents, currency, locale)}
            </Text>
          </Flex>
        )}
        <Separator size="4" />
        <Flex align="center" justify="between" gap="4" py="3">
          <Text size="3" weight="bold">
            {t("breakdownOwes")}
          </Text>
          <Text size="3" weight="bold">
            {money(credit.personOwesCents)}
          </Text>
        </Flex>
      </Flex>
      {schedule !== null && schedule.remainingCount > 0 && (
        <Text size="2" color="gray">
          {t("breakdownSchedule", { count: schedule.remainingCount, amount: moneyText(schedule.remainingTotalCents, currency, locale) })}
        </Text>
      )}
    </Flex>
  );
}

/**
 * The small breakdown behind «le falta $X». The debt's detail already holds the credit and passes it; a list that
 * carries only the figure passes the credit's id and the dialog reads it when it opens: pending, refused and done.
 */
export function ThirdPartyBreakdownDialog({
  open,
  onOpenChange,
  liabilityAccountId,
  person,
  currency,
  credit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  liabilityAccountId: string;
  person: string;
  currency: CurrencyCode;
  credit?: Breakdown;
}) {
  const t = useTranslations("thirdPartyCredit");
  const tKey = useTranslations();
  const read = useAction(readThirdPartyCreditAction);
  const { execute } = read;

  useEffect(() => {
    if (!credit) execute({ liabilityAccountId });
  }, [credit, execute, liabilityAccountId]);

  const shown = credit ?? read.result.data;
  const failed = !credit && (read.hasErrored || read.result.serverError !== undefined);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("breakdownTitle", { person })}</Dialog.Title>
        {shown ? (
          <BreakdownBody credit={shown} currency={currency} />
        ) : failed ? (
          <Flex direction="column" gap="3" align="start">
            <Text size="2" role="alert">
              {t("breakdownError")}
            </Text>
            <Button type="button" variant="soft" color="gray" onClick={() => execute({ liabilityAccountId })}>
              {tKey("common.retry")}
            </Button>
          </Flex>
        ) : (
          <Flex align="center" gap="2" role="status">
            <Spinner />
            <Text size="2" color="gray">
              {t("breakdownLoading")}
            </Text>
          </Flex>
        )}
        <Flex justify="end" mt="4">
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
