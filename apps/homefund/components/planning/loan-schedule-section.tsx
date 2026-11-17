"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";

import { Badge, Callout, Flex, Heading, Panel, PanelBlock, Separator, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { LoanScheduleSummary, RowView } from "@/lib/loan-schedule";
import type { Locale } from "@/lib/locales";
import { useMoneyText } from "@/lib/use-privacy";

const STATE_COLOR = { paid: "green", partial: "amber", pending: "gray" } as const;

/**
 * The payment schedule the bank printed for a loan (RF-266): a warning ahead of a cuota far from the usual one and one
 * line per cuota with its state in words. What is left to pay, the next cuota and the counters sit under «De dónde sale»
 * (RF-287). Every figure arrives derived from the rows and the loan's payments; none is summed here.
 */
export function LoanScheduleSection({ schedule, currency }: { schedule: LoanScheduleSummary; currency: CurrencyCode }) {
  const t = useTranslations("loanSchedule");
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();

  const amount = (cents: number) => moneyText(cents, currency, locale);
  const day = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short", year: "numeric" });
  // «agosto 2027»: the month and its year, never «de».
  const monthName = (date: string) => {
    const when = civilDateToDate(date);
    return `${format.dateTime(when, { month: "long" })} ${format.dateTime(when, { year: "numeric" })}`;
  };

  const [firstDiffering, ...otherDiffering] = schedule.differing;

  // A row paid short says how much is missing, in every case: «Vencida» is for a cuota nothing reached (RF-287).
  function stateLine(row: RowView): { text: string; color: "green" | "amber" | "red" | "gray" } {
    if (row.state === "paid") return { text: t("statePaid"), color: STATE_COLOR.paid };
    if (row.state === "partial") {
      return { text: t("statePartial", { left: amount(row.totalCents - row.paidCents) }), color: STATE_COLOR.partial };
    }
    if (row.overdue) return { text: t("stateOverdue"), color: "red" };
    return { text: t("statePending"), color: STATE_COLOR.pending };
  }

  return (
    <>
      <Flex direction="column" gap="3" px={{ initial: "0", md: "6" }}>
        <Heading as="h2" size="3">
          {t("title")}
        </Heading>
        {firstDiffering && (
          <Callout.Root color="amber" variant="soft" role="status">
            <Callout.Text>
              {t("differs", {
                month: monthName(firstDiffering.dueOn),
                amount: amount(firstDiffering.totalCents),
                usual: amount(firstDiffering.usualCents),
              })}
              {otherDiffering.length > 0 && ` ${t("differsMore", { count: otherDiffering.length })}`}
            </Callout.Text>
          </Callout.Root>
        )}
      </Flex>

      <Flex direction="column" px={{ initial: "0", md: "6" }}>
        <Panel title={t("rowsTitle")}>
          {schedule.rows.map((row, index) => {
            const state = stateLine(row);
            return (
              <Fragment key={row.number}>
                {index > 0 && <Separator size="4" />}
                <PanelBlock>
                  <Flex align="center" justify="between" gap="4" py="2" wrap="wrap">
                    <Flex direction="column">
                      <Text size="2" weight="medium">
                        {t("rowTitle", { number: row.number, date: day(row.dueOn) })}
                      </Text>
                      <Text size="2" color="gray">
                        {t("rowParts", {
                          principal: amount(row.principalCents),
                          interest: amount(row.interestCents),
                          insurance: amount(row.insuranceCents),
                        })}
                      </Text>
                    </Flex>
                    <Flex direction="column" align="end" gap="1">
                      <Text size="2" weight="medium">
                        {amount(row.totalCents)}
                      </Text>
                      <Flex align="center" gap="2">
                        <Badge color={state.color} variant="soft" radius="full">
                          {state.text}
                        </Badge>
                        <Text size="1" color="gray">
                          {t("rowBalance", { amount: amount(row.remainingCents) })}
                        </Text>
                      </Flex>
                    </Flex>
                  </Flex>
                </PanelBlock>
              </Fragment>
            );
          })}
        </Panel>
      </Flex>
    </>
  );
}
