"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { removeThirdPartyCreditAction } from "@/app/actions/third-party-credits";
import { EditThirdPartyDialog } from "@/components/planning/third-party-credit-dialog";
import { ThirdPartyBreakdownDialog } from "@/components/planning/third-party-breakdown";
import { ThirdPartyPaymentDialog } from "@/components/planning/third-party-payment-dialog";
import {
  Button,
  Box,
  Callout,
  ConfirmDialog,
  Flex,
  Heading,
  Money,
  Panel,
  PanelBlock,
  Separator,
  StatTiles,
  Table,
  Text,
} from "@/components/ui";
import type { ThirdPartyCreditView } from "@/db/queries/third-party-credits";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { sideState, type CreditMonth } from "@/lib/third-party-credit";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { useMoneyText } from "@/lib/use-privacy";

// The em dash an empty cell reads as elsewhere on the screen.
const NONE = "—";

/**
 * «Lo paga <persona>» (RF-212): a credit somebody else pays, read over three figures, this month's two
 * transfers and the months before it. Every figure arrives derived from the movements; nothing is summed here.
 * A caller the policies would not let write the credit is offered no button.
 */
export function ThirdPartyCreditSection({
  credit,
  banks,
}: {
  credit: ThirdPartyCreditView;
  // Where the payer's money may have arrived: the person's accounts without the «Me debe».
  banks: { id: string; name: string }[];
}) {
  const t = useTranslations("thirdPartyCredit");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const moneyText = useMoneyText();
  const onActionError = useActionErrorToast();
  const [dialog, setDialog] = useState<"payment" | "edit" | "stop" | "breakdown" | null>(null);

  const stop = useAction(removeThirdPartyCreditAction, {
    onSuccess() {
      toast.success(t("stopped"));
      setDialog(null);
    },
    onError: onActionError,
  });

  const { personName: person, currency, installmentCents } = credit;
  const amount = (cents: number) => moneyText(cents, currency, locale);
  const day = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short" });
  const monthName = (month: string) =>
    format.dateTime(civilDateToDate(`${month}-01`), { month: "long", year: "numeric" });
  // «agosto 2027»: the month of a cuota and its year, never «de».
  const cuotaMonth = (date: string) => {
    const when = civilDateToDate(date);
    return `${format.dateTime(when, { month: "long" })} ${format.dateTime(when, { year: "numeric" })}`;
  };

  // The current month is always the first line of the history.
  const [now] = credit.months;

  const dueNote =
    installmentCents !== null && credit.dueDay !== null
      ? t("noteInstallmentDue", { amount: amount(installmentCents), day: credit.dueDay })
      : installmentCents !== null
        ? t("noteInstallment", { amount: amount(installmentCents) })
        : credit.dueDay !== null
          ? t("noteDue", { day: credit.dueDay })
          : undefined;

  // With the bank's schedule at hand, what the payer still has to send reads beside the capital, with interest (RF-266).
  const { schedule } = credit;
  const scheduleNote =
    schedule !== null && schedule.remainingCount > 0
      ? t("scheduleLeft", { person, count: schedule.remainingCount, amount: amount(schedule.remainingTotalCents) })
      : undefined;
  // The first cuota the payer's usual amount will not cover, said before its day.
  const [uncovered, ...moreUncovered] = schedule?.uncovered ?? [];

  const tiles = [
    {
      key: "remaining",
      label: t("remaining"),
      value: <Money minor={credit.owedCents} currency={currency} signed={false} size="inherit" />,
      note: scheduleNote ?? dueNote,
    },
    {
      key: "paid",
      label: t("personPaid", { person }),
      value: <Money minor={credit.personPaidCents} currency={currency} signed={false} size="inherit" />,
    },
    {
      key: "owes",
      label: t("personOwes", { person }),
      value: <Money minor={credit.personOwesCents} currency={currency} signed={false} size="inherit" />,
      // How the figure is worked out opens from its note (RF-267).
      note: (
        <Button
          type="button"
          variant="ghost"
          size="1"
          tap={false}
          aria-label={t("breakdownOpen", { person })}
          onClick={() => setDialog("breakdown")}
        >
          {t("breakdownHint")}
        </Button>
      ),
    },
  ];

  // One side of a month in words, with its date when it happened: a state is never colour alone.
  function sideLine(kind: "person" | "lender", month: CreditMonth) {
    const cents = kind === "person" ? month.paidCents : month.lenderCents;
    const on = kind === "person" ? month.paidOn : month.lenderOn;
    const state = sideState(cents, installmentCents);
    if (state === "none" || on === null) {
      return { text: kind === "person" ? t("notArrived") : t("lenderNot"), done: false };
    }
    if (state === "partial" && installmentCents !== null) {
      const values = { amount: amount(cents), installment: amount(installmentCents), date: day(on) };
      return { text: kind === "person" ? t("arrivedPart", values) : t("lenderPart", values), done: false };
    }
    const values = { amount: amount(cents), date: day(on) };
    return { text: kind === "person" ? t("arrived", values) : t("lenderPaid", values), done: true };
  }

  // The month in progress with nothing from the payer yet, named before it is late (RF-267).
  const waiting = now !== undefined && now.paidCents === 0 && credit.personOwesCents > 0;
  const monthOnly = (month: string) => format.dateTime(civilDateToDate(`${month}-01`), { month: "long" });
  const lender = credit.lenderName;

  // One side of a month on a line: the amount and its day, or the dash.
  const side = (cents: number, on: string | null) => (cents === 0 || on === null ? NONE : `${amount(cents)} · ${day(on)}`);
  // What the payer sent less what was paid to the lender: where the 4x1000 and the cushion go.
  const difference = (month: CreditMonth) =>
    month.paidCents === 0 && month.lenderCents === 0 ? NONE : amount(month.paidCents - month.lenderCents);

  // One side of a month for the table: the amount and, under it, the day of its last transfer.
  const cell = (cents: number, on: string | null) =>
    cents === 0 || on === null ? (
      NONE
    ) : (
      <Flex direction="column">
        <Text size="2">{amount(cents)}</Text>
        <Text size="1" color="gray">
          {day(on)}
        </Text>
      </Flex>
    );

  const rows = now
    ? [
        { key: "person", label: t("personRow", { person }), line: sideLine("person", now) },
        { key: "lender", label: t("lenderRow"), line: sideLine("lender", now) },
      ]
    : [];

  return (
    <>
      <Flex direction="column" gap="3" px={{ initial: "0", md: "6" }}>
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Heading as="h2" size="3">
            {t("title", { person })}
          </Heading>
          {credit.canWrite && (
            <Flex align="center" gap="2" wrap="wrap">
              <Button type="button" variant="surface" color="gray" onClick={() => setDialog("payment")}>
                {t("register", { person })}
              </Button>
              <Button type="button" variant="surface" color="gray" onClick={() => setDialog("edit")}>
                {t("changePerson")}
              </Button>
              <Button type="button" variant="surface" color="red" onClick={() => setDialog("stop")}>
                {t("unlink")}
              </Button>
            </Flex>
          )}
        </Flex>
        <Flex direction="column" gap="1">
          <Text size="2">{lender === null ? t("introNoLender", { person }) : t("intro", { person, lender })}</Text>
          <Text size="2" weight="medium">
            {t("capitalLeft", { amount: amount(credit.owedCents) })}
            {schedule !== null && schedule.remainingCount > 0 &&
              ` · ${t("withInterest", { amount: amount(schedule.remainingTotalCents), count: schedule.remainingCount })}`}
          </Text>
          <Text size="2" color="gray">
            {t("openingLine", { amount: amount(credit.openingCents), date: day(credit.openedOn) })}
          </Text>
        </Flex>
        {waiting && (
          <Callout.Root color="amber" variant="soft" role="status">
            <Callout.Text>
              {credit.dueDay === null
                ? t("waitingNoDay", { person, month: monthOnly(now.month) })
                : t("waiting", { person, month: monthOnly(now.month), day: credit.dueDay })}
            </Callout.Text>
          </Callout.Root>
        )}
      </Flex>

      <StatTiles tiles={tiles} />

      {uncovered && schedule?.personUsualCents != null && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Callout.Root color="amber" variant="soft" role="status">
            <Callout.Text>
              {t("scheduleUncovered", {
                month: cuotaMonth(uncovered.dueOn),
                amount: amount(uncovered.totalCents),
                person,
                usual: amount(schedule.personUsualCents),
              })}
              {moreUncovered.length > 0 && ` ${t("scheduleUncoveredMore", { count: moreUncovered.length })}`}
            </Callout.Text>
          </Callout.Root>
        </Flex>
      )}

      {now && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("thisMonth", { month: monthName(now.month) })}>
            <Flex direction="column" px="4" py="1">
              {rows.map((row, index) => (
                <Fragment key={row.key}>
                  {index > 0 && <Separator size="4" />}
                  <Flex align="center" justify="between" gap="4" py="3" wrap="wrap">
                    <Text size="2" color="gray">
                      {row.label}
                    </Text>
                    <Text size="2" weight="medium" align="right" color={row.line.done ? "green" : undefined}>
                      {row.line.text}
                    </Text>
                  </Flex>
                </Fragment>
              ))}
            </Flex>
          </Panel>
        </Flex>
      )}

      {credit.months.length > 0 && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("history")}>
            {/* The phone has no room for four columns: each month reads as a block there. */}
            <Box display={{ initial: "block", md: "none" }}>
              {credit.months.map((month) => (
                <PanelBlock key={month.month}>
                  <Flex direction="column" gap="1" py="2">
                    <Text size="2" weight="medium">
                      {monthName(month.month)}
                    </Text>
                    <Text size="2" color="gray">
                      {t("colSent", { person })}: {side(month.paidCents, month.paidOn)}
                    </Text>
                    <Text size="2" color="gray">
                      {lender === null ? t("colPaidBank") : t("colPaid", { lender })}: {side(month.lenderCents, month.lenderOn)}
                    </Text>
                    <Text size="2" color="gray">
                      {t("colDifference")}: {difference(month)}
                    </Text>
                  </Flex>
                </PanelBlock>
              ))}
            </Box>
            <Box display={{ initial: "none", md: "block" }}>
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>{t("colMonth")}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>{t("colSent", { person })}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>{lender === null ? t("colPaidBank") : t("colPaid", { lender })}</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">{t("colDifference")}</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {credit.months.map((month) => (
                  <Table.Row key={month.month}>
                    <Table.RowHeaderCell>{monthName(month.month)}</Table.RowHeaderCell>
                    <Table.Cell>{cell(month.paidCents, month.paidOn)}</Table.Cell>
                    <Table.Cell>{cell(month.lenderCents, month.lenderOn)}</Table.Cell>
                    <Table.Cell justify="end">{difference(month)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
            </Box>
          </Panel>
        </Flex>
      )}

      {dialog === "payment" && (
        <ThirdPartyPaymentDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          credit={credit}
          banks={banks}
        />
      )}
      {dialog === "breakdown" && (
        <ThirdPartyBreakdownDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          liabilityAccountId={credit.liabilityAccountId}
          person={person}
          currency={currency}
          credit={credit}
        />
      )}
      {dialog === "edit" && (
        <EditThirdPartyDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          credit={credit}
        />
      )}
      <ConfirmDialog
        open={dialog === "stop"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t("stopTitle")}
        description={t("stopDescription", { person })}
        cancelLabel={tKey("common.cancel")}
        confirmLabel={t("stop")}
        tone="danger"
        pending={stop.isPending}
        onConfirm={() => stop.execute({ liabilityAccountId: credit.liabilityAccountId })}
      />
    </>
  );
}
