"use client";

import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";

import {
  Badge,
  CategoryTile,
  DataTable,
  Flex,
  Money,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { CurrencyCode } from "@/lib/currency";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// One delivery, already named: the screen holds the account and category maps
// and resolves the currency a missing account falls back to (RF-121), so a
// cell costs no lookup of its own.
export type InboxTableRow = {
  id: string;
  createdAt: Date;
  merchantLabel: string | null;
  rawText: string;
  category: { name: string; color: string | null } | null;
  account: string | null;
  // Null only when the message named no figure at all; an account-less amount
  // still carries the scope's currency rather than falling back to pesos.
  amountMinor: number | null;
  currency: CurrencyCode;
  isComplete: boolean;
};

// Tight on purpose: `lg` starts at 1280px (Radix Themes' own breakpoint), and
// that floor is where every fixed track and the flexible message column both
// have to fit — never a wider viewport most of this table will actually see.
const WIDTHS = {
  arrived: "88px",
  message: "minmax(0, 1fr)",
  merchant: "120px",
  category: "120px",
  account: "120px",
  amount: "90px",
  state: "150px",
} as const;

/**
 * The review queue as a dense table (RF-90, RF-91, RF-99): one row per pending
 * delivery, newest last as the query hands them over. Nothing here decides
 * anything — the caller owns the accept/review/reject verbs, so a row's menu
 * can route an incomplete "accept" into the prefilled form without this
 * component knowing the movement form exists.
 */
export function InboxTable({
  rows,
  empty,
  onAccept,
  onReview,
  onReject,
}: {
  rows: InboxTableRow[];
  empty?: ReactNode;
  onAccept: (id: string) => void;
  onReview: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const t = useTranslations("ingest");
  const format = useFormatter();

  const columns: DataColumn<InboxTableRow>[] = [
    {
      key: "arrived",
      header: t("dateLabel"),
      width: WIDTHS.arrived,
      cell: (row) => (
        <Text size="2" color="gray">
          {format.dateTime(row.createdAt, {
            day: "numeric",
            month: "short",
          })}
        </Text>
      ),
    },
    {
      key: "message",
      header: t("rawTextLabel"),
      width: WIDTHS.message,
      // Flex, not a bare `Text`: a raw SMS runs well past this column, and a
      // truncated inline element only actually shrinks once it is a flex item
      // with `minWidth="0"` to give up (SPEC-A3's own fix for the same gap in
      // the ledger's description column).
      cell: (row) => (
        <Flex minWidth="0">
          <Text size="2" color="gray" truncate>
            {row.rawText}
          </Text>
        </Flex>
      ),
    },
    {
      key: "merchant",
      header: t("merchantLabel"),
      width: WIDTHS.merchant,
      cell: (row) => (
        <Flex minWidth="0">
          <Text size="2" color="gray" truncate>
            {row.merchantLabel ?? NO_VALUE}
          </Text>
        </Flex>
      ),
    },
    {
      key: "category",
      header: t("categoryLabel"),
      width: WIDTHS.category,
      cell: (row) =>
        row.category ? (
          <Flex align="center" gap="2" minWidth="0">
            <CategoryTile color={row.category.color} size={9} />
            <Text size="2" color="gray" truncate>
              {row.category.name}
            </Text>
          </Flex>
        ) : (
          <Text size="2" color="amber">
            {t("categoryMissing")}
          </Text>
        ),
    },
    {
      key: "account",
      header: t("accountLabel"),
      width: WIDTHS.account,
      cell: (row) =>
        row.account ? (
          <Flex minWidth="0">
            <Text size="2" color="gray" truncate>
              {row.account}
            </Text>
          </Flex>
        ) : (
          <Text size="2" color="amber">
            {t("accountMissing")}
          </Text>
        ),
    },
    {
      key: "amount",
      header: t("amountLabel"),
      width: WIDTHS.amount,
      align: "end",
      numeric: true,
      cell: (row) =>
        row.amountMinor === null ? (
          <Text size="2" color="amber">
            {t("amountMissing")}
          </Text>
        ) : (
          <Money minor={row.amountMinor} currency={row.currency} tone="plain" />
        ),
    },
    {
      key: "state",
      header: t("stateLabel"),
      width: WIDTHS.state,
      align: "end",
      cell: (row) => (
        <Flex align="center" justify="end" gap="2">
          <Badge color={row.isComplete ? "green" : "amber"}>
            {row.isComplete ? t("stateComplete") : t("stateIncomplete")}
          </Badge>
          <RowMenu
            rowName={row.merchantLabel ?? t("noMerchant")}
            items={[
              {
                key: "accept",
                label: t("accept"),
                // A complete proposal records in one action; an incomplete one
                // opens the same prefilled form "openForm" does, never writing
                // on its own (RF-91).
                onSelect: () =>
                  row.isComplete ? onAccept(row.id) : onReview(row.id),
              },
              {
                key: "openForm",
                label: t("openForm"),
                onSelect: () => onReview(row.id),
              },
              {
                key: "reject",
                label: t("reject"),
                tone: "danger",
                onSelect: () => onReject(row.id),
              },
            ]}
          />
        </Flex>
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
