"use client";

import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { toast } from "sonner";

import {
  pauseRecurringRuleAction,
  resumeRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import {
  Badge,
  CategoryTile,
  DataTable,
  Flex,
  Money,
  RowMenu,
  Switch,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import { civilDateToDate } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";

// A frequency's own message key, since a template literal built from the union
// would widen to `string` and lose next-intl's typed key check.
const FREQUENCY_LABEL = {
  weekly: "frequencyWeekly",
  monthly: "frequencyMonthly",
  yearly: "frequencyYearly",
} as const;

// The tracks of the Recurrentes artboard, in order. Each range holds the
// artboard's width as its maximum, so the 1440 canvas draws exactly what
// SPEC-A3 specifies; below it the seven fixed tracks would together leave the
// concept nothing, so they give room back until the rule's name reaches its
// floor of 168px — enough for a name and the "Auto" badge beside it. The amount
// never shrinks: a figure would spill out of the cell rather than truncate.
const WIDTHS = {
  concept: "minmax(168px, 1fr)",
  frequency: "minmax(118px, 140px)",
  nextRun: "minmax(84px, 96px)",
  category: "minmax(112px, 152px)",
  account: "minmax(112px, 156px)",
  status: "minmax(100px, 132px)",
  amount: "128px",
  menu: "36px",
} as const;

/**
 * One rule the screen draws, already named: the caller resolves the concept
 * fallback, the category and the account, so a cell costs no lookup of its own.
 */
export type RecurringTableRow = {
  id: string;
  concept: string;
  frequency: RecurringRuleRow["frequency"];
  intervalN: number;
  nextRunOn: string;
  category: { name: string; color: string | null };
  account: string;
  isActive: boolean;
  amountCents: number;
  // What the amount is drawn in: the settlement currency of the one account the
  // rule names (RF-121).
  currency: string;
  // A destination-only rule is income, a source-only rule an expense (RF-29).
  isIncome: boolean;
};

/**
 * The dense Recurrentes of `private/design-desktop/SPEC-A3.md` (RF-29..32): a
 * rule per row carrying its own switch, named for the rule it pauses or resumes
 * (RF-32) — never a bare "Pausar" a screen reader could not place. Editing opens
 * the caller's dialog; deleting reaches `deleteRecurringRuleAction` with this
 * row's id.
 */
export function RecurringTable({
  rows,
  empty,
  onEdit,
  onViewGenerated,
  onDelete,
}: {
  rows: RecurringTableRow[];
  empty?: ReactNode;
  onEdit: (row: RecurringTableRow) => void;
  onViewGenerated: (row: RecurringTableRow) => void;
  onDelete: (row: RecurringTableRow) => void;
}) {
  const t = useTranslations("recurringRules");
  const tKey = useTranslations();
  const format = useFormatter();

  function shortDate(date: string): string {
    return format.dateTime(civilDateToDate(date), {
      day: "numeric",
      month: "short",
    });
  }

  function frequencyLabel(row: RecurringTableRow): string {
    return row.intervalN > 1
      ? t(`frequencyEvery.${row.frequency}`, { n: row.intervalN })
      : t(FREQUENCY_LABEL[row.frequency]);
  }

  const columns: DataColumn<RecurringTableRow>[] = [
    {
      key: "concept",
      header: t("tableConcept"),
      width: WIDTHS.concept,
      cell: (row) => (
        <Flex align="center" gap="2" minWidth="0">
          <Text size="2" weight="medium" truncate>
            {row.concept}
          </Text>
          <Badge color="amber" variant="soft" radius="full">
            {t("autoBadge")}
          </Badge>
        </Flex>
      ),
    },
    {
      key: "frequency",
      header: t("tableFrequency"),
      width: WIDTHS.frequency,
      // A block, not the default inline span: `truncate` clips nothing on an
      // inline box, so an overlong label would paint over the next column.
      cell: (row) => (
        <Text as="div" size="2" color="gray" truncate>
          {frequencyLabel(row)}
        </Text>
      ),
    },
    {
      key: "nextRun",
      header: t("tableNext"),
      width: WIDTHS.nextRun,
      numeric: true,
      // The rows arrive ordered by next run, soonest first, out of Postgres, and
      // no other order is on offer, so the chevron reports the sort rather than
      // opening one.
      sort: "asc",
      cell: (row) => (
        <Text size="2" color="gray">
          {shortDate(row.nextRunOn)}
        </Text>
      ),
    },
    {
      key: "category",
      header: t("tableCategory"),
      width: WIDTHS.category,
      cell: (row) => (
        <Flex align="center" gap="2" minWidth="0">
          <CategoryTile color={row.category.color} size={9} />
          <Text size="2" color="gray" truncate>
            {row.category.name}
          </Text>
        </Flex>
      ),
    },
    {
      key: "account",
      header: t("tableAccount"),
      width: WIDTHS.account,
      cell: (row) => (
        <Text as="div" size="2" color="gray" truncate>
          {row.account}
        </Text>
      ),
    },
    {
      key: "status",
      header: t("tableStatus"),
      width: WIDTHS.status,
      cell: (row) => <StatusCell row={row} />,
    },
    {
      key: "amount",
      header: t("tableAmount"),
      width: WIDTHS.amount,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Money
          minor={row.amountCents}
          currency={row.currency}
          tone={row.isIncome ? "income" : "expense"}
        />
      ),
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (row) => (
        <RowMenu
          rowName={row.concept}
          items={[
            { key: "edit", label: tKey("common.edit"), onSelect: () => onEdit(row) },
            {
              key: "viewGenerated",
              label: t("rowViewGenerated"),
              onSelect: () => onViewGenerated(row),
            },
            {
              key: "delete",
              label: tKey("common.delete"),
              tone: "danger",
              onSelect: () => onDelete(row),
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
      rows={rows}
      rowKey={(row) => row.id}
      empty={empty}
    />
  );
}

// Its own component, not a bare cell function: pausing and resuming call a
// hook, and a hook only obeys the rules of hooks from inside a component one
// row's switch actually mounts.
function StatusCell({ row }: { row: RecurringTableRow }) {
  const t = useTranslations("recurringRules");
  const onActionError = useActionErrorToast();

  const pause = useAction(pauseRecurringRuleAction, {
    onSuccess() {
      toast.success(t("pausedToast"));
    },
    onError: onActionError,
  });
  const resume = useAction(resumeRecurringRuleAction, {
    onSuccess() {
      toast.success(t("resumedToast"));
    },
    onError: onActionError,
  });
  const isPending = pause.isPending || resume.isPending;

  function onToggle(active: boolean) {
    if (active) resume.execute({ id: row.id });
    else pause.execute({ id: row.id });
  }

  return (
    <Flex align="center" gap="2">
      <Switch
        checked={row.isActive}
        onCheckedChange={onToggle}
        disabled={isPending}
        aria-label={
          row.isActive
            ? t("pauseSwitchLabel", { name: row.concept })
            : t("resumeSwitchLabel", { name: row.concept })
        }
      />
      <Text size="2" color="gray">
        {row.isActive ? t("stateActive") : t("statePaused")}
      </Text>
    </Flex>
  );
}
