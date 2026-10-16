"use client";

import { Fragment, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  Badge,
  CategoryTile,
  DataTable,
  Flex,
  Money,
  Progress,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import { formatMoney } from "@/lib/money";

// The minus U+2212 money.tsx reserves for a signed figure — this column signs
// its own, since `quedan` runs negative on an overspent budget and Money only
// ever signs by tone, never by the cents it is handed.
const MINUS = "−";

// The tracks of the Presupuestos artboard, in order.
const WIDTHS = {
  category: "190px",
  progress: "1fr",
  status: "132px",
  spent: "124px",
  limit: "124px",
  remaining: "130px",
  menu: "36px",
} as const;

/**
 * One budget the screen draws, already named: the caller resolves the category
 * title and colour, so a cell costs no lookup of its own.
 */
export type BudgetTableRow = {
  id: string;
  title: string;
  color: string | null;
  // What this row's three figures are counted in, derived by the server from
  // the budget's account, fund or owner (RF-121).
  currency: string;
  spentCents: number;
  limitCents: number;
  remainingCents: number;
  thresholdPct: number;
  overThreshold: boolean;
  overspent: boolean;
};

/**
 * The dense Presupuestos of `private/design-desktop/SPEC-A3.md` (RF-72, RF-73):
 * a budget per row with its bar and a total that sums every row on screen. The
 * spend a bar and a badge read is the server's own derivation, never a sum this
 * table takes over a list of movements (RNF-07); the badge only names a
 * threshold crossed or a limit passed, and stays empty under either.
 */
export function BudgetsTable({
  rows,
  archived,
  empty,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  rows: BudgetTableRow[];
  // An archived budget is read-only: the way back is all its menu offers.
  archived: boolean;
  empty?: ReactNode;
  onEdit: (row: BudgetTableRow) => void;
  onArchive: (row: BudgetTableRow) => void;
  onRestore: (row: BudgetTableRow) => void;
  onDelete: (row: BudgetTableRow) => void;
}) {
  const t = useTranslations("budgets");
  const tKey = useTranslations();
  const locale = useLocale();

  function figure(cents: number, currency: string): string {
    return formatMoney(cents, currency, locale);
  }

  // The percentage a bar and its aria-label read, clamped so an overspend never
  // runs the track past its end (SPEC-A3).
  function pctOf(row: { spentCents: number; limitCents: number }): number {
    if (row.limitCents > 0) {
      return Math.min(100, Math.round((row.spentCents / row.limitCents) * 100));
    }
    return row.spentCents > 0 ? 100 : 0;
  }

  function toneOf(row: { overspent: boolean; overThreshold: boolean }) {
    if (row.overspent) return "red" as const;
    if (row.overThreshold) return "amber" as const;
    return undefined;
  }

  // `quedan` runs negative once a budget is overspent; it reads with the
  // ledger's own minus and in red rather than through Money's fixed tones,
  // which sign by kind and never by the figure they are handed.
  function remainingCell(cents: number, currency: string) {
    const negative = cents < 0;
    return (
      <Text color={negative ? "red" : undefined} weight={negative ? "bold" : undefined}>
        {negative && MINUS}
        <Money
          minor={Math.abs(cents)}
          currency={currency}
          tone="plain"
          signed={false}
        />
      </Text>
    );
  }

  // One running pair per currency on screen, in the order the rows introduce
  // them: no total ever adds two currencies together (RF-124). With a single
  // currency — every list until an account settles elsewhere — each total cell
  // draws the one figure it always did.
  const totals = new Map<string, { spentCents: number; limitCents: number }>();
  for (const row of rows) {
    const running = totals.get(row.currency) ?? { spentCents: 0, limitCents: 0 };
    running.spentCents += row.spentCents;
    running.limitCents += row.limitCents;
    totals.set(row.currency, running);
  }
  const totalRows = [...totals.entries()];
  const single = totalRows.length === 1 ? totalRows[0] : null;

  const columns: DataColumn<BudgetTableRow>[] = [
    {
      key: "category",
      header: t("tableCategory"),
      width: WIDTHS.category,
      cell: (row) => (
        <Flex align="center" gap="2" minWidth="0">
          <CategoryTile color={row.color} size={9} />
          <Text size="2" weight="medium" truncate>
            {row.title}
          </Text>
          {/* Which spend the limit counts: the movements booked in this one
              currency and no other (RF-124). */}
          <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
            {tKey("planning.inCurrency", { currency: row.currency })}
          </Text>
        </Flex>
      ),
    },
    {
      key: "progress",
      header: t("tableProgress"),
      width: WIDTHS.progress,
      cell: (row) => (
        <Progress
          value={pctOf(row)}
          color={toneOf(row)}
          aria-label={t("tableProgressLabel", {
            name: row.title,
            amount: figure(row.spentCents, row.currency),
            limit: figure(row.limitCents, row.currency),
            pct: pctOf(row),
          })}
        />
      ),
    },
    {
      key: "status",
      header: t("tableStatus"),
      width: WIDTHS.status,
      cell: (row) =>
        row.overspent ? (
          <Badge color="red" variant="soft" radius="full">
            {t("tableOverspent")}
          </Badge>
        ) : (
          row.overThreshold && (
            <Badge color="amber" variant="soft" radius="full">
              {t("tableNearLimit", { threshold: row.thresholdPct })}
            </Badge>
          )
        ),
    },
    {
      key: "spent",
      header: t("tableSpent"),
      width: WIDTHS.spent,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Money minor={row.spentCents} currency={row.currency} signed={false} />
      ),
    },
    {
      key: "limit",
      header: t("tableLimit"),
      width: WIDTHS.limit,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Text color="gray">
          <Money minor={row.limitCents} currency={row.currency} signed={false} />
        </Text>
      ),
    },
    {
      key: "remaining",
      header: t("tableRemaining"),
      width: WIDTHS.remaining,
      align: "end",
      numeric: true,
      cell: (row) => remainingCell(row.remainingCents, row.currency),
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (row) => (
        <RowMenu
          rowName={row.title}
          items={
            archived
              ? [
                  {
                    key: "restore",
                    label: tKey("common.restore"),
                    onSelect: () => onRestore(row),
                  },
                  {
                    key: "delete",
                    label: tKey("common.delete"),
                    tone: "danger",
                    onSelect: () => onDelete(row),
                  },
                ]
              : [
                  {
                    key: "edit",
                    label: tKey("common.edit"),
                    onSelect: () => onEdit(row),
                  },
                  {
                    key: "archive",
                    label: tKey("common.archive"),
                    onSelect: () => onArchive(row),
                  },
                  {
                    key: "delete",
                    label: tKey("common.delete"),
                    tone: "danger",
                    onSelect: () => onDelete(row),
                  },
                ]
          }
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
      total={
        rows.length > 0
          ? [
              <Text key="label" size="1" weight="bold" color="gray">
                {t("tableTotal").toUpperCase()}
              </Text>,
              // A bar over two currencies is a percentage of nothing, so it is
              // drawn only while the list counts one.
              single ? (
                <Progress
                  key="progress"
                  value={pctOf(single[1])}
                  aria-label={t("tableTotalProgressLabel", {
                    amount: figure(single[1].spentCents, single[0]),
                    limit: figure(single[1].limitCents, single[0]),
                    pct: pctOf(single[1]),
                  })}
                />
              ) : null,
              null,
              <Flex key="spent" direction="column" align="end">
                {totalRows.map(([currency, sums]) => (
                  <Money
                    key={currency}
                    minor={sums.spentCents}
                    currency={currency}
                    signed={false}
                  />
                ))}
              </Flex>,
              <Flex key="limit" direction="column" align="end">
                {totalRows.map(([currency, sums]) => (
                  <Text key={currency} color="gray">
                    <Money
                      minor={sums.limitCents}
                      currency={currency}
                      signed={false}
                    />
                  </Text>
                ))}
              </Flex>,
              <Flex key="remaining" direction="column" align="end">
                {totalRows.map(([currency, sums]) => (
                  <Fragment key={currency}>
                    {remainingCell(sums.limitCents - sums.spentCents, currency)}
                  </Fragment>
                ))}
              </Flex>,
            ]
          : undefined
      }
    />
  );
}
