import { ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import {
  CategoryTile,
  EmptyState,
  Flex,
  Link,
  TapTarget,
  Money,
  Panel,
  PanelRow,
  Text,
} from "@/components/ui";
import type { TransactionListRow } from "@/db/queries/transactions";
import { Link as LocaleLink } from "@/i18n/navigation";
import { civilDateToDate } from "@/lib/dates";

// A transfer carries neither category nor sign; an income and an expense read
// their first split's category and lean on the kind word only when none is set.
export type KindLabels = {
  transfer: string;
  income: string;
  expense: string;
  adjustment: string;
};

// The row grid of the Inicio artboard: tile, title over account, date, amount.
const COLUMNS = "36px 1fr 110px 160px";

/**
 * The desktop dashboard's tail: the movements the ledger opens with (RF-23), each
 * a row into its detail, over a link to the full list. The names arrive already
 * mapped by the page, so a row costs no lookup of its own, and the amount is the
 * last cell in every one of them (RF-17, RF-18, RF-69).
 */
export function RecentMovements({
  rows,
  kindLabels,
  accountNames,
  categoryNames,
  categoryColors,
}: {
  rows: TransactionListRow[];
  kindLabels: KindLabels;
  accountNames: Map<string, string>;
  categoryNames: Map<string, string>;
  categoryColors: Map<string, string | null>;
}) {
  const t = useTranslations("transactions");
  const td = useTranslations("dashboard");
  const format = useFormatter();

  return (
    <Panel
      title={t("listTitle")}
      action={
        <Link asChild size="2" weight="medium">
          <LocaleLink href="/movements">
            {/* A line of text has no control height of its own. */}
            <TapTarget align="center" gap="1">
              {t("seeAll")}
              <ChevronRight size={13} strokeWidth={2.4} aria-hidden />
            </TapTarget>
          </LocaleLink>
        </Link>
      }
    >
      {rows.length === 0 && (
        <EmptyState variant="filtered" title={td("emptyTitle")} />
      )}

      {rows.map((row) => (
        <PanelRow
          key={row.id}
          href={`/movements/${row.id}`}
          columns={COLUMNS}
          cells={[
            {
              key: "tile",
              content: (
                <CategoryTile color={rowColor(row, categoryColors)} size={36} />
              ),
            },
            {
              key: "title",
              content: (
                <Flex direction="column" minWidth="0">
                  <Text size="2" weight="medium" truncate>
                    {rowTitle(row, categoryNames, kindLabels)}
                  </Text>
                  <Text size="1" color="gray" truncate>
                    {rowSubtitle(row, accountNames)}
                  </Text>
                </Flex>
              ),
            },
            {
              key: "date",
              numeric: true,
              // A block, so the date owns its line box: as a span it would ride
              // the cell's inherited strut and drop off the row's optical line.
              content: (
                <Text as="div" size="2" color="gray">
                  {format.dateTime(civilDateToDate(row.occurredAt), {
                    day: "numeric",
                    month: "short",
                  })}
                </Text>
              ),
            },
            {
              key: "amount",
              align: "end",
              // The amount as it was booked, in the currency it was booked in
              // (RF-121); the second amount belongs to the detail screen.
              content: (
                <Money
                  minor={
                    row.reconciliationId !== null && row.toAccountId === null
                      ? -row.amountCents
                      : row.amountCents
                  }
                  currency={row.currency}
                  tone={rowTone(row)}
                  signed={row.reconciliationId !== null ? "always" : true}
                />
              ),
            },
          ]}
        />
      ))}
    </Panel>
  );
}

// A transfer names no category, so its title is the fixed kind word; an income or
// expense reads its first split's category (RF-19).
export function rowTitle(
  row: TransactionListRow,
  categoryNames: Map<string, string>,
  kindLabels: KindLabels,
): string {
  if (row.reconciliationId !== null) return kindLabels.adjustment;
  if (row.kind === "transfer") return kindLabels.transfer;
  const first = row.splits[0]?.categoryId;
  const fallback = row.kind === "income" ? kindLabels.income : kindLabels.expense;
  return (first && categoryNames.get(first)) || fallback;
}

// A transfer reads "origin → destination"; an income names its destination, an
// expense its source.
export function rowSubtitle(
  row: TransactionListRow,
  accountNames: Map<string, string>,
): string | undefined {
  if (row.reconciliationId !== null) {
    const accountId = row.toAccountId ?? row.fromAccountId;
    return (accountId && accountNames.get(accountId)) ?? undefined;
  }
  if (row.kind === "transfer") {
    const from = (row.fromAccountId && accountNames.get(row.fromAccountId)) ?? "";
    const to = (row.toAccountId && accountNames.get(row.toAccountId)) ?? "";
    return `${from} → ${to}`;
  }
  const accountId = row.kind === "income" ? row.toAccountId : row.fromAccountId;
  return (accountId && accountNames.get(accountId)) ?? undefined;
}

// A transfer wears no category colour, so its tile stays the neutral surface.
export function rowColor(
  row: TransactionListRow,
  categoryColors: Map<string, string | null>,
): string | null {
  if (row.reconciliationId !== null || row.kind === "transfer") return null;
  const first = row.splits[0]?.categoryId;
  return (first && categoryColors.get(first)) ?? null;
}

// The union both `Money` and `MovementRow` accept, so the phone's card and the
// desktop row read one derivation.
export function rowTone(
  row: TransactionListRow,
): "income" | "transfer" | "expense" {
  if (row.reconciliationId !== null) return "transfer";
  if (row.kind === "income") return "income";
  if (row.kind === "transfer") return "transfer";
  return "expense";
}
