"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import {
  Badge,
  type BadgeProps,
  Box,
  Card,
  DataTable,
  Dialog,
  Flex,
  RowMenu,
  TablePagination,
  Text,
  type DataColumn,
} from "@/components/ui";
import { TIME_ZONE } from "@/lib/locales";

// One audit row, already named: the screen resolves the entity, action and
// actor labels (their maps are its own), so this table costs no lookup.
export type AuditTableRow = {
  id: number;
  occurredAt: Date;
  entity: string;
  action: "INSERT" | "UPDATE" | "DELETE";
  actionLabel: string;
  actor: string;
  recordId: string;
};

// The write kind colours the badge: a creation reads green, an edit amber, a
// removal red — the same mapping the screen's own `Table.Root` drew before
// this replaced it.
const ACTION_COLOR: Record<AuditTableRow["action"], BadgeProps["color"]> = {
  INSERT: "green",
  UPDATE: "amber",
  DELETE: "red",
};

// The id is a UUID (RF-53's trigger stamps the source row's key verbatim): a
// column too narrow to show it in full still has to hold enough of it, and
// its row menu, to stay above zero.
const RECORD_ID_FLOOR = "160px";

const WIDTHS = {
  occurredAt: "172px",
  entity: "180px",
  action: "116px",
  actor: "170px",
  recordId: `minmax(${RECORD_ID_FLOOR}, 1fr)`,
} as const;

// The table draws from `lg` up. Its floor keeps the flexible column from
// collapsing to zero between `lg` and the width the fixed columns need, so it
// scrolls with the rest instead (D16).
const MIN_WIDTH = `calc(${WIDTHS.occurredAt} + ${WIDTHS.entity} + ${WIDTHS.action} + ${WIDTHS.actor} + ${RECORD_ID_FLOOR})`;

/**
 * The read-only audit trail (RF-53): a dense table from `lg` up and a list of
 * cards on the phone, where the five tracks do not fit (RNF-08). Its row menu only
 * ever reads: viewing the row's own already-fetched fields at full length, or
 * copying its record id. Neither calls a server action, because the log
 * answers to its own trigger and to nothing a person clicks here (RF-45).
 */
export function AuditTable({
  rows,
  empty,
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  rows: AuditTableRow[];
  empty?: ReactNode;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("audit");
  const format = useFormatter();
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const details = rows.find((row) => row.id === detailsId) ?? null;

  async function copyRecordId(row: AuditTableRow) {
    try {
      await navigator.clipboard.writeText(row.recordId);
      setCopiedId(row.id);
      setTimeout(
        () => setCopiedId((current) => (current === row.id ? null : current)),
        2000,
      );
    } catch {
      // No clipboard access: the details dialog still shows the id to select
      // and copy by hand, so the row menu never dead-ends silently.
      setDetailsId(row.id);
    }
  }

  // The same two reads in the table's cells and on the phone's cards.
  const dateLabel = (row: AuditTableRow, withYear: boolean) =>
    format.dateTime(row.occurredAt, {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      timeZone: TIME_ZONE,
    });

  const menuItems = (row: AuditTableRow) => [
    {
      key: "details",
      label: t("viewDetails"),
      onSelect: () => setDetailsId(row.id),
    },
    {
      key: "copy",
      label: copiedId === row.id ? t("recordIdCopied") : t("copyRecordId"),
      onSelect: () => copyRecordId(row),
    },
  ];

  const columns: DataColumn<AuditTableRow>[] = [
    {
      key: "occurredAt",
      header: t("colOccurredAt"),
      width: WIDTHS.occurredAt,
      cell: (row) => (
        <Text size="2" color="gray">
          {dateLabel(row, true)}
        </Text>
      ),
    },
    {
      key: "entity",
      header: t("colEntity"),
      width: WIDTHS.entity,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.entity}
        </Text>
      ),
    },
    {
      key: "action",
      header: t("colAction"),
      width: WIDTHS.action,
      cell: (row) => (
        <Badge color={ACTION_COLOR[row.action]}>{row.actionLabel}</Badge>
      ),
    },
    {
      key: "actor",
      header: t("colActor"),
      width: WIDTHS.actor,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.actor}
        </Text>
      ),
    },
    {
      key: "recordId",
      header: t("colRecordId"),
      width: WIDTHS.recordId,
      cell: (row) => (
        <Flex align="center" justify="between" gap="2" minWidth="0">
          <Text size="1" color="gray" truncate>
            {row.recordId}
          </Text>
          <RowMenu
            rowName={row.entity}
            items={menuItems(row)}
          />
        </Flex>
      ),
    },
  ];

  const pagination = pageCount > 1 && (
    <TablePagination
      caption={t("pageStatus", { page, pages: pageCount })}
      onPrev={page > 1 ? onPrev : undefined}
      onNext={page < pageCount ? onNext : undefined}
      prevLabel={t("previousPage")}
      nextLabel={t("nextPage")}
    />
  );

  return (
    <>
      <Box display={{ initial: "none", lg: "block" }}>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.id)}
          minWidth={MIN_WIDTH}
          empty={empty}
          footer={pagination}
        />
      </Box>

      {/* The phone reads a change as a card: the five tracks do not fit. */}
      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="3">
          {rows.length === 0 && empty}
          {rows.map((row) => (
            <Card key={row.id}>
              <Flex direction="column" gap="1">
                <Flex justify="between" align="center" gap="2">
                  <Text size="3" weight="medium" truncate>
                    {row.entity}
                  </Text>
                  <Badge color={ACTION_COLOR[row.action]}>{row.actionLabel}</Badge>
                </Flex>
                <Text size="2" color="gray">
                  {row.actor} ·{" "}
                  {dateLabel(row, false)}
                </Text>
                <Flex align="center" justify="between" gap="2" minWidth="0">
                  <Text size="1" color="gray" truncate>
                    {row.recordId}
                  </Text>
                  <RowMenu
                    rowName={row.entity}
                    items={menuItems(row)}
                  />
                </Flex>
              </Flex>
            </Card>
          ))}
          {pagination}
        </Flex>
      </Box>

      <Dialog.Root
        open={details !== null}
        onOpenChange={(open) => !open && setDetailsId(null)}
      >
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>{t("detailsTitle")}</Dialog.Title>
          {details && (
            <Flex direction="column" gap="3" mt="3">
              <DetailRow label={t("colOccurredAt")}>
                {format.dateTime(details.occurredAt, {
                  dateStyle: "long",
                  timeStyle: "medium",
                  timeZone: TIME_ZONE,
                })}
              </DetailRow>
              <DetailRow label={t("colEntity")}>{details.entity}</DetailRow>
              <DetailRow label={t("colAction")}>
                {details.actionLabel}
              </DetailRow>
              <DetailRow label={t("colActor")}>{details.actor}</DetailRow>
              <DetailRow label={t("colRecordId")}>
                {details.recordId}
              </DetailRow>
            </Flex>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Flex direction="column" gap="1">
      <Text size="1" weight="medium" color="gray">
        {label}
      </Text>
      <Text size="2">{children}</Text>
    </Flex>
  );
}
