"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";

import { Badge, Callout, Flex, Heading, Money, Panel, PanelBlock, Separator, StatTiles, Text } from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import type { LoanScheduleSummary, RowView } from "@/lib/loan-schedule";
import type { Locale } from "@/lib/locales";
import { useMoneyText } from "@/lib/use-privacy";

// The em dash a tile with nothing to name reads as elsewhere on the screen.
const NO_VALUE = "—";

const STATE_COLOR = { paid: "green", partial: "amber", pending: "gray" } as const;

/**
 * The payment schedule the bank printed for a loan (RF-258): the next cuota, how many are left, what is still to pay
 * with interest and insurance and when it ends, a warning ahead of a cuota far from the usual one, and one line per
 * cuota with its state in words. Every figure arrives derived from the rows and the loan's payments; none is summed here.
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

  const { next, count, remainingCount } = schedule;
  const [firstDiffering, ...otherDiffering] = schedule.differing;

  const tiles = [
    {
      key: "next",
      label: t("tileNext"),
      value: next === null ? NO_VALUE : <Money minor={next.totalCents} currency={currency} signed={false} size="inherit" />,
      note: next === null ? t("tileNextDone") : t("tileNextNote", { number: next.number, count, date: day(next.dueOn) }),
    },
    {
      key: "left",
      label: t("tileLeft"),
      value: remainingCount,
      note: t("tileLeftNote", { count }),
    },
    {
      key: "remaining",
      label: t("tileRemaining"),
      value: <Money minor={schedule.remainingTotalCents} currency={currency} signed={false} size="inherit" />,
      note: t("tileRemainingNote"),
    },
    {
      key: "ends",
      label: t("tileEnds"),
      value: monthName(schedule.endsOn),
      note: day(schedule.endsOn),
    },
  ];

  function stateLine(row: RowView): { text: string; color: "green" | "amber" | "red" | "gray" } {
    if (row.state === "paid") return { text: t("statePaid"), color: STATE_COLOR.paid };
    if (row.overdue) return { text: t("stateOverdue"), color: "red" };
    if (row.state === "partial") return { text: t("statePartial", { paid: amount(row.paidCents) }), color: STATE_COLOR.partial };
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

      <StatTiles tiles={tiles} />

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
