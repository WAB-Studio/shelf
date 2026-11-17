"use client";

import { Plus, TriangleAlert } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  cancelPlannedPaymentAction,
  deletePlannedPaymentAction,
} from "@/app/actions/planned-payments";
import {
  deleteRecurringRuleAction,
  pauseRecurringRuleAction,
  resumeRecurringRuleAction,
  skipRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import { OwnerMark } from "@/components/fund/owner-mark";
import { UpcomingFormDialog } from "@/components/planning/upcoming-form-dialog";
import { UpcomingSettleDialog } from "@/components/planning/upcoming-settle-dialog";
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DateTile,
  EmptyState,
  Flex,
  FundChip,
  MovementRow,
  PlainLink,
  RowMenu,
  ScreenHeader,
  Text,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { RecurringCharge } from "@/db/queries/spending-patterns";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { useRouter } from "@/i18n/navigation";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { dateAfterSkip, previewOf, upcomingItems, type UpcomingItem } from "@/lib/fund/upcoming";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { useMoneyText } from "@/lib/use-privacy";

type Removal = { payment: PlannedPaymentRow } | { rule: RecurringRuleRow };

/**
 * «Lo que viene»: the payments that fall due, the incomes that are expected, the rules that repeat and the
 * subscriptions HomeFund found, as one list ordered by date. Each row says what it is, its amount and day, its
 * account and offers one action; the rest sit in its menu. A kind with nothing in it shows nothing.
 */
export function UpcomingScreen({
  payments,
  rules,
  charges,
  unreviewedCount,
  options,
  hasGroup,
}: {
  payments: PlannedPaymentRow[];
  rules: RecurringRuleRow[];
  charges: RecurringCharge[];
  unreviewedCount: number;
  options: TransactionFormOptions;
  hasGroup: boolean;
}) {
  const t = useTranslations("upcoming");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  // "new" and a row share one dialog instance; its own key resets the form.
  const [formTarget, setFormTarget] = useState<
    { payment: PlannedPaymentRow } | { rule: RecurringRuleRow } | "new" | null
  >(null);
  const [settleTarget, setSettleTarget] = useState<PlannedPaymentRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PlannedPaymentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Removal | null>(null);

  const items = useMemo(() => upcomingItems({ payments, rules, charges }), [payments, rules, charges]);
  const accountNames = new Map(options.accountDirectory.map((account) => [account.id, account.name]));

  const cancelState = useAction(cancelPlannedPaymentAction, {
    onSuccess() {
      toast.success(t(cancelTarget && cancelTarget.fromAccountId === null ? "cancel.income" : "cancel.paid"));
      setCancelTarget(null);
    },
    onError: onActionError,
  });
  const deletePayment = useAction(deletePlannedPaymentAction, {
    onSuccess() {
      toast.success(t("delete.done"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });
  const deleteRule = useAction(deleteRecurringRuleAction, {
    onSuccess() {
      toast.success(t("delete.done"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });

  const addButton = (
    <Button type="button" onClick={() => setFormTarget("new")}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
        meta={hasGroup ? <FundChip label={tKey("fund.label")} /> : undefined}
        actions={addButton}
      />

      {/* Generated movements land marked automatic until confirmed (RF-31); the banner leads to the ledger to
          review them and stays hidden at zero. */}
      {unreviewedCount > 0 && (
        <PlainLink href="/movements?unreviewed=1">
          <Callout.Root color="amber" variant="soft">
            <Callout.Icon>
              <TriangleAlert size={16} aria-hidden />
            </Callout.Icon>
            <Callout.Text>{tKey("recurringRules.unreviewedBanner", { count: unreviewedCount })}</Callout.Text>
          </Callout.Root>
        </PlainLink>
      )}

      {items.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} action={addButton} />
      ) : (
        <Flex direction="column" gap="3">
          {items.map((item) => (
            <UpcomingCard
              key={`${item.kind}:${previewOf(item).key}`}
              item={item}
              accountNames={accountNames}
              onSettle={setSettleTarget}
              onEditPayment={(payment) => setFormTarget({ payment })}
              onEditRule={(rule) => setFormTarget({ rule })}
              onCancel={setCancelTarget}
              onDelete={setDeleteTarget}
            />
          ))}
        </Flex>
      )}

      <UpcomingFormDialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        options={options}
        payment={formTarget && formTarget !== "new" && "payment" in formTarget ? formTarget.payment : undefined}
        rule={formTarget && formTarget !== "new" && "rule" in formTarget ? formTarget.rule : undefined}
      />

      <UpcomingSettleDialog
        open={settleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSettleTarget(null);
        }}
        payment={settleTarget ?? undefined}
      />

      {cancelTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setCancelTarget(null)}
          title={t(cancelTarget.fromAccountId === null ? "cancel.incomeTitle" : "cancel.payTitle")}
          description={t("cancel.description")}
          confirmLabel={t(cancelTarget.fromAccountId === null ? "cancel.incomeTitle" : "cancel.payTitle")}
          cancelLabel={tKey("common.cancel")}
          tone="neutral"
          pending={cancelState.isPending}
          onConfirm={() => cancelState.execute({ plannedPaymentId: cancelTarget.id })}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={t("delete.title")}
          description={t("delete.description")}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={deletePayment.isPending || deleteRule.isPending}
          onConfirm={() =>
            "payment" in deleteTarget
              ? deletePayment.execute({ plannedPaymentId: deleteTarget.payment.id })
              : deleteRule.execute({ id: deleteTarget.rule.id })
          }
        />
      )}
    </Flex>
  );
}

function UpcomingCard({
  item,
  accountNames,
  onSettle,
  onEditPayment,
  onEditRule,
  onCancel,
  onDelete,
}: {
  item: UpcomingItem;
  accountNames: Map<string, string>;
  onSettle: (payment: PlannedPaymentRow) => void;
  onEditPayment: (payment: PlannedPaymentRow) => void;
  onEditRule: (rule: RecurringRuleRow) => void;
  onCancel: (payment: PlannedPaymentRow) => void;
  onDelete: (target: Removal) => void;
}) {
  const moneyText = useMoneyText();
  const t = useTranslations("upcoming");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const onActionError = useActionErrorToast();

  const skip = useAction(skipRecurringRuleAction, {
    onSuccess() {
      if (item.kind === "rule") {
        toast.success(
          t("skipped", {
            date: format.dateTime(civilDateToDate(dateAfterSkip(item.rule)), { day: "numeric", month: "long" }),
          }),
        );
      }
    },
    onError: onActionError,
  });
  const pause = useAction(pauseRecurringRuleAction, {
    onSuccess() {
      toast.success(tKey("recurringRules.pausedToast"));
    },
    onError: onActionError,
  });
  const resume = useAction(resumeRecurringRuleAction, {
    onSuccess() {
      toast.success(tKey("recurringRules.resumedToast"));
    },
    onError: onActionError,
  });

  const { name, amountCents, currency } = previewOf(item);
  const title = name ?? tKey("plannedPayments.noConcept");
  const due = civilDateToDate(item.date);
  const late = item.date < todayInBogota();

  // What the row is, in words, and where the money moves.
  let kindWord: string;
  let accountId: string | null;
  let foreignOwner = false;
  let ownerName: string | null = null;
  let note: string | null = null;
  let income = false;
  let action: { label: string; pending: boolean; onPress: () => void } | null = null;
  const menu: { key: string; label: string; onSelect: () => void; tone?: "danger" }[] = [];

  switch (item.kind) {
    case "payment":
    case "income": {
      const { payment } = item;
      income = item.kind === "income";
      kindWord = t(income ? "kind.income" : "kind.payment");
      accountId = payment.fromAccountId ?? payment.toAccountId;
      ({ foreignOwner, ownerName } = payment);
      if (late) note = t(income ? "late.income" : "late.payment");
      action = {
        label: t(income ? "act.arrived" : "act.pay"),
        pending: false,
        onPress: () => onSettle(payment),
      };
      menu.push(
        { key: "edit", label: tKey("common.edit"), onSelect: () => onEditPayment(payment) },
        {
          key: "cancel",
          label: t(income ? "menu.cancelIncome" : "menu.cancelPayment"),
          onSelect: () => onCancel(payment),
        },
        { key: "delete", label: t("menu.delete"), tone: "danger", onSelect: () => onDelete({ payment }) },
      );
      break;
    }
    case "rule": {
      const { rule } = item;
      income = rule.toAccountId !== null;
      kindWord = t(`kind.repeat.${rule.frequency}`, { n: rule.intervalN });
      accountId = rule.fromAccountId ?? rule.toAccountId;
      ({ foreignOwner, ownerName } = rule);
      if (!rule.isActive) {
        note = rule.pausedReason === "failed" ? tKey("recurringRules.pausedFailed") : t("paused");
      }
      action = rule.isActive
        ? {
            label: t(`act.skip.${rule.frequency}`),
            pending: skip.isPending,
            onPress: () => skip.execute({ id: rule.id }),
          }
        : { label: t("act.edit"), pending: false, onPress: () => onEditRule(rule) };
      if (rule.isActive) menu.push({ key: "edit", label: tKey("common.edit"), onSelect: () => onEditRule(rule) });
      menu.push(
        rule.isActive
          ? { key: "pause", label: t("menu.pause"), onSelect: () => pause.execute({ id: rule.id }) }
          : { key: "resume", label: t("menu.resume"), onSelect: () => resume.execute({ id: rule.id }) },
        {
          key: "generated",
          label: tKey("recurringRules.rowViewGenerated"),
          onSelect: () => router.push(`/movements?rule=${rule.id}`),
        },
        { key: "delete", label: t("menu.delete"), tone: "danger", onSelect: () => onDelete({ rule }) },
      );
      break;
    }
    case "subscription": {
      const { charge } = item;
      kindWord = t("kind.subscription");
      accountId = charge.accountId;
      note = [
        late ? t("late.subscription") : null,
        t(`cadence.${charge.cadence}`),
        t("estimate", { count: charge.occurrences }),
      ]
        .filter(Boolean)
        .join(" · ");
      action = {
        label: t("act.seeMovements"),
        pending: false,
        onPress: () => router.push(`/movements?q=${encodeURIComponent(charge.name)}`),
      };
      break;
    }
  }

  const account = accountId ? accountNames.get(accountId) : undefined;
  // Another member's personal plan can be read, never changed.
  const mayAct = !foreignOwner;

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="start" gap="2">
          <Flex flexGrow="1" minWidth="0">
            <MovementRow
              tile={
                <DateTile
                  day={format.dateTime(due, { day: "numeric" })}
                  month={format.dateTime(due, { month: "short" })}
                />
              }
              title={title}
              subtitle={[kindWord, account].filter(Boolean).join(" · ")}
              amount={moneyText(amountCents, currency, locale)}
              tone={income ? "income" : "transfer"}
              wrap
            />
          </Flex>
          {mayAct && menu.length > 0 && <RowMenu rowName={title} items={menu} />}
        </Flex>
        {note && (
          <Text size="2" color={late && item.kind !== "rule" ? "red" : "gray"}>
            {note}
          </Text>
        )}
        <OwnerMark foreignOwner={foreignOwner} ownerName={ownerName} />
        {mayAct && action && (
          <Button
            type="button"
            variant="surface"
            color={late && item.kind !== "rule" ? "amber" : "gray"}
            disabled={action.pending}
            onClick={action.onPress}
          >
            {action.label}
          </Button>
        )}
      </Flex>
    </Card>
  );
}
