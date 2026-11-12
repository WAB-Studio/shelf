"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { removeThirdPartyCreditAction } from "@/app/actions/third-party-credits";
import { EditThirdPartyDialog } from "@/components/planning/third-party-credit-dialog";
import { ThirdPartyPaymentDialog } from "@/components/planning/third-party-payment-dialog";
import {
  Button,
  ConfirmDialog,
  Flex,
  Heading,
  Money,
  Panel,
  PanelBlock,
  RowMenu,
  Separator,
  StatTiles,
  Text,
} from "@/components/ui";
import type { ThirdPartyCreditView } from "@/db/queries/third-party-credits";
import { civilDateToDate } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { sideState, type CreditMonth } from "@/lib/third-party-credit";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { useMoneyText } from "@/lib/use-privacy";

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
  const [dialog, setDialog] = useState<"payment" | "edit" | "stop" | null>(null);

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

  // The current month is always the first line of the history.
  const [now, ...before] = credit.months;

  const dueNote =
    installmentCents !== null && credit.dueDay !== null
      ? t("noteInstallmentDue", { amount: amount(installmentCents), day: credit.dueDay })
      : installmentCents !== null
        ? t("noteInstallment", { amount: amount(installmentCents) })
        : credit.dueDay !== null
          ? t("noteDue", { day: credit.dueDay })
          : undefined;

  const tiles = [
    {
      key: "remaining",
      label: t("remaining"),
      value: <Money minor={credit.owedCents} currency={currency} signed={false} size="inherit" />,
      note: dueNote,
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
      note: credit.receivableName,
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
            <Flex align="center" gap="2">
              <Button type="button" variant="surface" color="gray" onClick={() => setDialog("payment")}>
                {t("register", { person })}
              </Button>
              <RowMenu
                rowName={t("actionsFor", { person })}
                items={[
                  { key: "edit", label: t("edit"), onSelect: () => setDialog("edit") },
                  { key: "stop", label: t("stop"), onSelect: () => setDialog("stop"), tone: "danger" },
                ]}
              />
            </Flex>
          )}
        </Flex>
      </Flex>

      <StatTiles tiles={tiles} />

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

      {before.length > 0 && (
        <Flex direction="column" px={{ initial: "0", md: "6" }}>
          <Panel title={t("history")}>
            {before.map((month) => (
              <PanelBlock key={month.month}>
                <Flex direction="column" py="2">
                  <Text size="2" weight="medium">
                    {monthName(month.month)}
                  </Text>
                  <Text size="2" color="gray">
                    {month.paidCents > 0 ? t("monthArrived", { amount: amount(month.paidCents) }) : t("monthNotArrived")}
                    {" · "}
                    {month.lenderCents > 0 ? t("monthLender", { amount: amount(month.lenderCents) }) : t("monthLenderNot")}
                  </Text>
                </Flex>
              </PanelBlock>
            ))}
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
