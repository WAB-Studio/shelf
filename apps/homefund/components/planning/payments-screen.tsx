"use client";

import { EllipsisVertical, Info, Plus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  cancelPlannedPaymentAction,
  deletePlannedPaymentAction,
} from "@/app/actions/planned-payments";
import { PaymentFormDialog } from "@/components/planning/payment-form-dialog";
import { PaymentsTable } from "@/components/planning/payments-table";
import { PaymentSettleDialog } from "@/components/planning/payment-settle-dialog";
import { PlanningSubNav } from "@/components/planning/planning-sub-nav";
import {
  Box,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  Flex,
  FundChip,
  Heading,
  IconButton,
  MovementRow,
  Text,
  type DataSection,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { civilDateToDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * The planned-payments area: pending payments read as dated reminder rows grouped
 * by their due month, soonest first (RF-74). Each row's dropdown settles it into a
 * real movement, edits it, cancels it or deletes it; settling runs the reused
 * action and removes the row on refresh (RF-75). Money stays integer cents and
 * every figure is drawn in the settlement currency of the account the payment
 * names (RF-121).
 */
export function PaymentsScreen({
  payments,
  options,
  hasGroup,
}: {
  payments: PlannedPaymentRow[];
  options: TransactionFormOptions;
  hasGroup: boolean;
}) {
  const t = useTranslations("plannedPayments");
  const tKey = useTranslations();
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  // "new" and a row share one dialog instance; its own key resets the form.
  const [formTarget, setFormTarget] = useState<PlannedPaymentRow | "new" | null>(
    null,
  );
  const [settleTarget, setSettleTarget] = useState<PlannedPaymentRow | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<PlannedPaymentRow | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PlannedPaymentRow | null>(
    null,
  );

  // The query hands rows soonest-due first, so the keys land in chronological
  // order and each month's rows keep that order.
  const groups = useMemo(() => {
    const byMonth = new Map<string, PlannedPaymentRow[]>();
    for (const payment of payments) {
      const monthKey = payment.dueDate.slice(0, 7);
      const rows = byMonth.get(monthKey);
      if (rows) rows.push(payment);
      else byMonth.set(monthKey, [payment]);
    }
    return [...byMonth.entries()];
  }, [payments]);

  // A name and colour per category id — children included — and a name per
  // account id, so the desktop table reads a payment's row without a lookup
  // of its own.
  const categoryNames = new Map<string, string>();
  const categoryColors = new Map<string, string | null>();
  for (const category of options.categories) {
    categoryNames.set(category.id, category.name);
    categoryColors.set(category.id, category.color);
    for (const child of category.children) {
      categoryNames.set(child.id, child.name);
      categoryColors.set(child.id, child.color);
    }
  }
  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));

  // `groups` reshaped into the table's sections — one band per month, its
  // rows unchanged — so the month grouping is derived once for both widths.
  const sections: DataSection<PlannedPaymentRow>[] = groups.map(
    ([monthKey, rows]) => ({
      key: monthKey,
      label: format.dateTime(civilDateToDate(`${monthKey}-01`), {
        month: "long",
        year: "numeric",
      }),
      rows,
    }),
  );

  const cancelState = useAction(cancelPlannedPaymentAction, {
    onSuccess() {
      toast.success(t("cancelled"));
      setCancelTarget(null);
    },
    onError: onActionError,
  });

  const deleteState = useAction(deletePlannedPaymentAction, {
    onSuccess() {
      toast.success(t("deleted"));
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
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <Flex align="center" gap="2">
          <Heading size="5">{t("title")}</Heading>
          {hasGroup && <FundChip label={tKey("fund.label")} />}
        </Flex>
        {addButton}
      </Flex>

      <Box display={{ initial: "none", md: "block" }}>
        <PlanningSubNav />
      </Box>

      <Box display={{ initial: "block", lg: "none" }}>
      {payments.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={addButton}
        />
      ) : (
        <Flex direction="column" gap="4">
          {groups.map(([monthKey, rows]) => (
            <Flex key={monthKey} direction="column" gap="3">
              <Text
                size="1"
                weight="medium"
                color="gray"
                style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}
              >
                {format.dateTime(civilDateToDate(`${monthKey}-01`), {
                  month: "long",
                  year: "numeric",
                })}
              </Text>
              {rows.map((payment) => (
                <PaymentCard
                  key={payment.id}
                  payment={payment}
                  onSettle={() => setSettleTarget(payment)}
                  onEdit={() => setFormTarget(payment)}
                  onCancel={() => setCancelTarget(payment)}
                  onDelete={() => setDeleteTarget(payment)}
                />
              ))}
            </Flex>
          ))}
        </Flex>
      )}
      </Box>

      <Box display={{ initial: "none", lg: "block" }}>
        <PaymentsTable
          sections={sections}
          categoryNames={categoryNames}
          categoryColors={categoryColors}
          accountNames={accountNames}
          empty={
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={addButton}
            />
          }
          onSettle={(payment) => setSettleTarget(payment)}
          onEdit={(payment) => setFormTarget(payment)}
          onCancel={(payment) => setCancelTarget(payment)}
          onDelete={(payment) => setDeleteTarget(payment)}
        />
      </Box>

      {/* A planned payment only reminds; the person records the real movement
          when they settle it (RF-74, RF-75). */}
      <Callout.Root color="jade" variant="soft">
        <Callout.Icon>
          <Info size={16} aria-hidden />
        </Callout.Icon>
        <Callout.Text>{t("reminderHint")}</Callout.Text>
      </Callout.Root>

      <PaymentFormDialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        options={options}
        payment={formTarget === "new" ? undefined : (formTarget ?? undefined)}
      />

      <PaymentSettleDialog
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
          title={t("cancelTitle")}
          description={t("cancelDescription")}
          confirmLabel={t("cancelConfirm")}
          cancelLabel={tKey("common.cancel")}
          tone="neutral"
          pending={cancelState.isPending}
          onConfirm={() =>
            cancelState.execute({ plannedPaymentId: cancelTarget.id })
          }
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={deleteState.isPending}
          onConfirm={() =>
            deleteState.execute({ plannedPaymentId: deleteTarget.id })
          }
        />
      )}
    </Flex>
  );
}

function PaymentCard({
  payment,
  onSettle,
  onEdit,
  onCancel,
  onDelete,
}: {
  payment: PlannedPaymentRow;
  onSettle: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("plannedPayments");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();

  const due = civilDateToDate(payment.dueDate);

  return (
    <Card>
      <Flex align="center" gap="2">
        <Flex flexGrow="1" minWidth="0">
          <MovementRow
            tile={
              <DateTile
                day={format.dateTime(due, { day: "numeric" })}
                month={format.dateTime(due, { month: "short" })}
              />
            }
            title={payment.description ?? t("noConcept")}
            subtitle={t("reminder")}
            amount={formatMoney(payment.amountCents, payment.currency, locale)}
            tone="transfer"
          />
        </Flex>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              type="button"
              tap
              variant="ghost"
              color="gray"
              aria-label={tKey("common.actionsFor", {
                name: payment.description ?? t("noConcept"),
              })}
            >
              <EllipsisVertical size={16} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={onSettle}>
              {t("settle")}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onEdit}>
              {tKey("common.edit")}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onCancel}>
              {t("cancel")}
            </DropdownMenu.Item>
            <DropdownMenu.Item color="red" onSelect={onDelete}>
              {tKey("common.delete")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
    </Card>
  );
}

// The reminder's date tile: the due day over its abbreviated month, both already
// formatted by the caller in the active locale.
function DateTile({ day, month }: { day: string; month: string }) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      flexShrink="0"
      style={{
        width: 44,
        height: 44,
        borderRadius: 14,
        background: "var(--accent-a3)",
      }}
    >
      <Text size="2" weight="bold" style={{ lineHeight: 1 }}>
        {day}
      </Text>
      <Text size="1" color="gray">
        {month}
      </Text>
    </Flex>
  );
}
