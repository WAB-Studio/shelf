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
  undoSkipRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import { OwnerMark } from "@/components/fund/owner-mark";
import { DebtPaymentDialog, paymentDebtOf, type PaymentDebt } from "@/components/planning/debt-payment-dialog";
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
import type { UpcomingDebts } from "@/db/queries/home-lines";
import type { DebtsScreenData } from "@/db/queries/debts-screen";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { RecurringCharge } from "@/db/queries/spending-patterns";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { useRouter } from "@/i18n/navigation";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { monthlyByCurrency } from "@/lib/fund/subscriptions";
import { dateAfterSkip, previewOf, upcomingItems, type UpcomingItem } from "@/lib/fund/upcoming";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { useMoneyText } from "@/lib/use-privacy";

type Removal = { payment: PlannedPaymentRow } | { rule: RecurringRuleRow };

/**
 * «Lo que viene»: the payments that fall due, each card's and each loan's next payment (RF-308), the incomes that
 * are expected, the rules that repeat and the subscriptions HomeFund found, as one list ordered by date. Each row says
 * what it is, its amount and day, its account and offers one action; the rest sit in its menu. A kind with nothing in
 * it shows nothing.
 */
export function UpcomingScreen({
  payments,
  rules,
  charges,
  debts,
  payment,
  unreviewedCount,
  options,
}: {
  payments: PlannedPaymentRow[];
  rules: RecurringRuleRow[];
  charges: RecurringCharge[];
  debts: UpcomingDebts;
  // The debts the cards and loans above are paid through, and the assets they are paid from: the same dialog Deudas opens.
  payment: Pick<DebtsScreenData, "withTerms" | "withoutTerms" | "payFrom">;
  unreviewedCount: number;
  options: TransactionFormOptions;
}) {
  const t = useTranslations("upcoming");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();
  const moneyText = useMoneyText();
  const locale = useLocale();

  // "new" and a row share one dialog instance; its own key resets the form.
  const [formTarget, setFormTarget] = useState<
    { payment: PlannedPaymentRow } | { rule: RecurringRuleRow } | "new" | null
  >(null);
  const [settleTarget, setSettleTarget] = useState<PlannedPaymentRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PlannedPaymentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Removal | null>(null);
  const [payTarget, setPayTarget] = useState<{ debt: PaymentDebt; currency: CurrencyCode } | null>(null);

  const [onlySubscriptions, setOnlySubscriptions] = useState(false);
  const all = useMemo(
    () =>
      upcomingItems({
        payments,
        rules,
        charges,
        debts: [
          ...debts.cards.map((debt) => ({ kind: "card" as const, date: debt.dueDate, debt })),
          ...debts.loans.map((debt) => ({ kind: "loan" as const, date: debt.dueDate, debt })),
        ],
      }),
    [payments, rules, charges, debts],
  );
  const subscriptions = useMemo(() => all.filter((item) => item.kind === "subscription"), [all]);
  const items = onlySubscriptions ? subscriptions : all;
  // What the listed subscriptions cost a month, one figure per currency, never summed across currencies.
  const monthly = monthlyByCurrency(
    subscriptions.flatMap((item) => (item.kind === "subscription" ? [item.charge] : [])),
  )
    .map(([currency, cents]) => moneyText(cents, currency, locale))
    .join(" · ");
  const accountNames = new Map(options.accountDirectory.map((account) => [account.id, account.name]));
  // Only what moves a fund account wears the fund's mark.
  const fundAccountIds = new Set(options.accounts.filter((account) => account.groupId !== null).map((account) => account.id));

  // The payment dialog's own debt, read as the debts screen reads it; a loan asks what is left of its next cuota.
  function payDebt(item: Extract<UpcomingItem, { kind: "card" | "loan" }>) {
    const { accountId, currency } = item.debt;
    const withTerms = payment.withTerms.find((row) => row.accountId === accountId);
    const without = payment.withoutTerms.find((row) => row.accountId === accountId);
    const found = withTerms ? paymentDebtOf({ ...withTerms, terms: withTerms }) : without ? paymentDebtOf({ ...without, terms: null }) : null;
    if (found === null) return;
    const debt: PaymentDebt =
      item.kind === "loan"
        ? { ...found, loan: { hasSchedule: item.debt.number !== null, hasRate: found.loan?.hasRate ?? false, instalmentCents: item.debt.amountCents } }
        : found;
    setPayTarget({ debt, currency: currency as CurrencyCode });
  }

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

      {/* What the subscriptions cost a month; pressing it keeps only them, pressing again brings the rest back. */}
      {subscriptions.length > 0 && (
        <Button
          type="button"
          variant={onlySubscriptions ? "solid" : "soft"}
          color="gray"
          aria-pressed={onlySubscriptions}
          onClick={() => setOnlySubscriptions((on) => !on)}
        >
          {t("subscriptionsLine", { amount: monthly })}
        </Button>
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
              fundAccountIds={fundAccountIds}
              onSettle={setSettleTarget}
              onEditPayment={(payment) => setFormTarget({ payment })}
              onEditRule={(rule) => setFormTarget({ rule })}
              onCancel={setCancelTarget}
              onDelete={setDeleteTarget}
              onPayDebt={payDebt}
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
        options={options}
      />

      {payTarget && (
        <DebtPaymentDialog
          open
          onOpenChange={(open) => {
            if (!open) setPayTarget(null);
          }}
          debt={payTarget.debt}
          currency={payTarget.currency}
          payFrom={payment.payFrom}
        />
      )}

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
  fundAccountIds,
  onSettle,
  onEditPayment,
  onEditRule,
  onCancel,
  onDelete,
  onPayDebt,
}: {
  item: UpcomingItem;
  accountNames: Map<string, string>;
  fundAccountIds: ReadonlySet<string>;
  onSettle: (payment: PlannedPaymentRow) => void;
  onEditPayment: (payment: PlannedPaymentRow) => void;
  onEditRule: (rule: RecurringRuleRow) => void;
  onCancel: (payment: PlannedPaymentRow) => void;
  onDelete: (target: Removal) => void;
  onPayDebt: (item: Extract<UpcomingItem, { kind: "card" | "loan" }>) => void;
}) {
  const moneyText = useMoneyText();
  const t = useTranslations("upcoming");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const onActionError = useActionErrorToast();

  const undoSkip = useAction(undoSkipRecurringRuleAction, { onError: onActionError });
  // The skip applies at once; «Deshacer» gives the run back.
  const skip = useAction(skipRecurringRuleAction, {
    onSuccess({ data }) {
      if (item.kind === "rule") {
        const ruleId = item.rule.id;
        toast.success(
          t("skipped", {
            date: format.dateTime(civilDateToDate(dateAfterSkip(item.rule)), { day: "numeric", month: "long" }),
          }),
          data
            ? {
                action: {
                  label: tKey("transactions.undo"),
                  onClick: () => undoSkip.execute({ id: ruleId, nextRunOn: data.previousRunOn }),
                },
              }
            : undefined,
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
    case "card": {
      const { debt } = item;
      kindWord = t("kind.card");
      // The title already names the card.
      accountId = null;
      note = [
        late ? t("late.debt") : null,
        debt.totalCents === null
          ? t("cardNoStatement")
          : debt.minimumCents === null
            ? t("cardTotalOnly")
            : t("cardMinimum", { minimum: moneyText(debt.minimumCents, debt.currency, locale) }),
      ]
        .filter(Boolean)
        .join(" · ");
      action = { label: t("act.pay"), pending: false, onPress: () => onPayDebt(item) };
      break;
    }
    case "loan": {
      const { debt } = item;
      kindWord = t("kind.loan");
      accountId = null;
      note = [late ? t("late.debt") : null, debt.number === null || debt.count === null ? null : t("loanNumber", { number: debt.number, count: debt.count })]
        .filter(Boolean)
        .join(" · ");
      action = { label: t("act.pay"), pending: false, onPress: () => onPayDebt(item) };
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
  const movedId = item.kind === "card" || item.kind === "loan" ? item.debt.accountId : accountId;
  const ofFund = movedId !== null && fundAccountIds.has(movedId);
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
              amount={item.kind === "card" && item.debt.totalCents === null ? "—" : moneyText(amountCents, currency, locale)}
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
        {ofFund && <FundChip label={tKey("fund.label")} />}
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
