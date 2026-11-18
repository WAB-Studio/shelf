"use client";

import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";

import { readThirdPartyCreditAction } from "@/app/actions/third-party-credits";
import { Button, Dialog, Flex, Money, Separator, Spinner, Text } from "@/components/ui";
import type { ThirdPartyCreditView } from "@/db/queries/third-party-credits";
import type { CurrencyCode } from "@/lib/currency";
import type { Locale } from "@/lib/locales";
import { useMoneyText } from "@/lib/use-privacy";

type Breakdown = Pick<ThirdPartyCreditView, "personName" | "personOwesCents" | "schedule">;

/**
 * How «le falta» is built (RF-301): the capital the credit still owes, what the bank says is left, and, with a
 * payment schedule, what its unpaid cuotas ask with interest and insurance. Every figure arrives derived.
 */
function BreakdownBody({ credit, currency }: { credit: Breakdown; currency: CurrencyCode }) {
  const t = useTranslations("thirdPartyCredit");
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const { personName: person, schedule } = credit;

  return (
    <Flex direction="column" gap="3">
      <Text size="2" color="gray">
        {t("breakdownHow", { person })}
      </Text>
      <Separator size="4" />
      <Flex align="center" justify="between" gap="4" py="1">
        <Text size="3" weight="bold">
          {t("breakdownOwes")}
        </Text>
        <Text size="3" weight="bold">
          <Money minor={credit.personOwesCents} currency={currency} signed={false} size="inherit" />
        </Text>
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
