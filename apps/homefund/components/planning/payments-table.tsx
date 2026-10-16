"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";

import {
  Badge,
  Button,
  CategoryTile,
  DataTable,
  Flex,
  Money,
  RowMenu,
  Text,
  type DataColumn,
  type DataSection,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import { civilDateToDate, todayInBogota } from "@/lib/dates";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Pagos planificados artboard, in order.
const WIDTHS = {
  due: "86px",
  concept: "minmax(0, 1fr)",
  remind: "100px",
  category: "158px",
  account: "176px",
  amount: "124px",
  settle: "138px",
  menu: "36px",
} as const;

/**
 * The dense Pagos planificados of `private/design-desktop/SPEC-A3.md`
 * (RF-74, RF-75): one section per due month, each pending row carrying its own
 * "Registrar pago" and a settled row carrying only its mark. `categoryNames`,
 * `categoryColors` and `accountNames` are the caller's already-flattened maps —
 * a payment names an id, never a joined row, so the table reads them once
 * instead of asking Postgres for each name. Nothing is stored here: the status
 * a row settled or cancelled into arrives already decided (RNF-07).
 */
export function PaymentsTable({
  sections,
  categoryNames,
  categoryColors,
  accountNames,
  empty,
  onSettle,
  onEdit,
  onCancel,
  onDelete,
}: {
  sections: DataSection<PlannedPaymentRow>[];
  categoryNames: Map<string, string>;
  categoryColors: Map<string, string | null>;
  accountNames: Map<string, string>;
  empty?: ReactNode;
  onSettle: (payment: PlannedPaymentRow) => void;
  onEdit: (payment: PlannedPaymentRow) => void;
  onCancel: (payment: PlannedPaymentRow) => void;
  onDelete: (payment: PlannedPaymentRow) => void;
}) {
  const t = useTranslations("plannedPayments");
  const tKey = useTranslations();
  const format = useFormatter();

  // A pending payment past its due date reads "Vencido"; a settled or
  // cancelled one no longer waits on anything, so it never does.
  const today = todayInBogota();

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  // Both accounts named reads as a transfer, one account as the payment it is.
  function accountLabel(payment: PlannedPaymentRow): string {
    if (payment.fromAccountId && payment.toAccountId) {
      const from = accountNames.get(payment.fromAccountId) ?? "";
      const to = accountNames.get(payment.toAccountId) ?? "";
      return `${from} → ${to}`;
    }
    const accountId = payment.fromAccountId ?? payment.toAccountId;
    return (accountId && accountNames.get(accountId)) || NO_VALUE;
  }

  const columns: DataColumn<PlannedPaymentRow>[] = [
    {
      key: "due",
      header: t("tableDue"),
      width: WIDTHS.due,
      numeric: true,
      cell: (payment) => (
        <Text size="2" color="gray">
          {shortDate(payment.dueDate)}
        </Text>
      ),
    },
    {
      key: "concept",
      header: t("tableConcept"),
      width: WIDTHS.concept,
      cell: (payment) => (
        <Flex align="center" gap="2" minWidth="0">
          <Text size="2" weight="medium" truncate>
            {payment.description ?? t("noConcept")}
          </Text>
          {payment.status === "pending" && payment.dueDate < today && (
            <Badge color="amber" variant="soft" radius="full">
              {t("overdueLabel")}
            </Badge>
          )}
        </Flex>
      ),
    },
    {
      key: "remind",
      header: t("tableRemind"),
      width: WIDTHS.remind,
      numeric: true,
      cell: (payment) => (
        <Text size="2" color="gray">
          {payment.remindOn ? shortDate(payment.remindOn) : NO_VALUE}
        </Text>
      ),
    },
    {
      key: "category",
      header: t("tableCategory"),
      width: WIDTHS.category,
      cell: (payment) => {
        const categoryId = payment.categoryId;
        const name = categoryId && categoryNames.get(categoryId);
        if (!categoryId || !name) {
          return (
            <Text size="2" color="gray">
              {NO_VALUE}
            </Text>
          );
        }
        return (
          <Flex align="center" gap="2" minWidth="0">
            <CategoryTile color={categoryColors.get(categoryId) ?? null} size={9} />
            <Text size="2" color="gray" truncate>
              {name}
            </Text>
          </Flex>
        );
      },
    },
    {
      key: "account",
      header: t("tableAccount"),
      width: WIDTHS.account,
      cell: (payment) => (
        <Text size="2" color="gray" truncate>
          {accountLabel(payment)}
        </Text>
      ),
    },
    {
      key: "amount",
      header: t("tableAmount"),
      width: WIDTHS.amount,
      align: "end",
      numeric: true,
      cell: (payment) => (
        <Money
          minor={payment.amountCents}
          currency={payment.currency}
          tone={payment.status === "pending" ? "expense" : "transfer"}
          signed={false}
        />
      ),
    },
    {
      key: "settle",
      header: "",
      width: WIDTHS.settle,
      align: "end",
      // A settled or cancelled payment shows no control that reaches the
      // settle action — only its mark, if it has one.
      cell: (payment) => {
        if (payment.status === "pending") {
          return (
            <Button
              type="button"
              variant="surface"
              color="gray"
              onClick={() => onSettle(payment)}
            >
              {t("settle")}
            </Button>
          );
        }
        if (payment.status === "done") {
          return (
            <Flex align="center" justify="end" gap="1">
              <Check size={14} color="var(--jade-9)" aria-hidden />
              <Text size="2" color="jade">
                {t("settledMarker")}
              </Text>
            </Flex>
          );
        }
        return (
          <Text size="2" color="gray">
            {t("cancelledMarker")}
          </Text>
        );
      },
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (payment) => (
        <RowMenu
          rowName={payment.description ?? t("noConcept")}
          items={[
            ...(payment.status === "pending"
              ? [
                  {
                    key: "settle",
                    label: t("settle"),
                    onSelect: () => onSettle(payment),
                  },
                ]
              : []),
            {
              key: "edit",
              label: tKey("common.edit"),
              onSelect: () => onEdit(payment),
            },
            ...(payment.status === "pending"
              ? [
                  {
                    key: "cancel",
                    label: t("cancel"),
                    onSelect: () => onCancel(payment),
                  },
                ]
              : []),
            {
              key: "delete",
              label: tKey("common.delete"),
              tone: "danger" as const,
              onSelect: () => onDelete(payment),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      sections={sections}
      rowKey={(payment) => payment.id}
      empty={empty}
    />
  );
}
