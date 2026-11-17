"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { Button, Dialog, Flex, Separator, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { LoanScheduleSummary } from "@/lib/loan-schedule";
import type { LoanStanding } from "@/lib/loan-standing";
import type { Locale } from "@/lib/locales";
import { useMoneyText } from "@/lib/use-privacy";

type Line = { key: string; label: string; value: string };

/**
 * The one figure a loan leads with, «Falta pagar $X en N cuotas» (RF-287), and the button that says where it comes
 * from. Everything else a loan knows about what is left sits behind that button, each line in words: the same
 * figures the screen used to scatter, now in one place and adding up to the headline.
 */
export function LoanStandingBlock({
  standing,
  currency,
  balanceOwedCents,
  schedule,
  termMonths,
  installmentCents,
  paymentCount,
}: {
  standing: LoanStanding;
  currency: CurrencyCode;
  balanceOwedCents: number;
  schedule: LoanScheduleSummary | null;
  termMonths: number | null;
  installmentCents: number | null;
  paymentCount: number;
}) {
  const t = useTranslations("loanStanding");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const [open, setOpen] = useState(false);

  const amount = (cents: number) => moneyText(cents, currency, locale);
  const monthName = (date: string) => {
    const when = civilDateToDate(date);
    return `${format.dateTime(when, { month: "long" })} ${format.dateTime(when, { year: "numeric" })}`;
  };

  const headline =
    standing.owedCents === 0
      ? t("headlineDone")
      : standing.count === null
        ? t("headlineNoCount", { amount: amount(standing.owedCents) })
        : t("headline", { amount: amount(standing.owedCents), count: standing.count });

  const lines: Line[] = [];
  if (schedule !== null) {
    lines.push(
      { key: "paid", label: t("linePaid"), value: t("linePaidValue", { paid: schedule.paidCount, count: schedule.count }) },
      ...(schedule.partialCount > 0
        ? [{ key: "partial", label: t("linePartial"), value: String(schedule.partialCount) }]
        : []),
      { key: "left", label: t("lineLeft"), value: String(schedule.remainingCount) },
      { key: "total", label: t("lineWithInterest"), value: amount(schedule.remainingTotalCents) },
      { key: "capital", label: t("lineCapital"), value: amount(balanceOwedCents) },
      { key: "ends", label: t("lineEnds"), value: monthName(schedule.endsOn) },
    );
  } else {
    lines.push({ key: "capital", label: t("lineBalance"), value: amount(balanceOwedCents) });
    if (termMonths !== null) {
      lines.push(
        { key: "term", label: t("lineTerm"), value: t("lineTermValue", { count: termMonths }) },
        { key: "payments", label: t("linePayments"), value: String(paymentCount) },
      );
    }
    if (installmentCents !== null) {
      lines.push({ key: "installment", label: t("lineInstallment"), value: amount(installmentCents) });
    }
  }
  return (
    <Flex direction="column" align="start" gap="1">
      <Text size="4" weight="bold">
        {headline}
      </Text>
      <Button type="button" variant="ghost" size="1" tap={false} onClick={() => setOpen(true)}>
        {t("open")}
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content>
          <Dialog.Title>{t("title")}</Dialog.Title>
          <Flex direction="column" gap="3">
            <Text size="2" color="gray">
              {t(`source.${standing.source}`)}
            </Text>
            <Flex direction="column">
              {lines.map((line, index) => (
                <Fragment key={line.key}>
                  {index > 0 && <Separator size="4" />}
                  <Flex align="center" justify="between" gap="4" py="2">
                    <Text size="2">{line.label}</Text>
                    <Text size="2" weight="medium" align="right">
                      {line.value}
                    </Text>
                  </Flex>
                </Fragment>
              ))}
            </Flex>
          </Flex>
          <Flex justify="end" mt="4">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">
                {t("close")}
              </Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
