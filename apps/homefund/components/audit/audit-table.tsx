"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import {
  Badge,
  type BadgeProps,
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

// This is the only screen that draws its `DataTable` under `md` (RNF-08's
// exception, see the module 35 report): the fixed columns alone already
// outrun a phone's viewport, so the flexible one needs a floor too, or grid's
// negative-free-space step shrinks it to zero instead of scrolling with the
// rest (D16).
const MIN_WIDTH = `calc(${WIDTHS.occurredAt} + ${WIDTHS.entity} + ${WIDTHS.action} + ${WIDTHS.actor} + ${RECORD_ID_FLOOR})`;

/**
 * The read-only audit trail (RF-53) as a dense table, replacing the screen's
 * fixed `Table.Root` rather than sitting beside it — the screen already draws
 * this at every width, so no sibling split applies (RNF-08). Its row menu only
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

  const columns: DataColumn<AuditTableRow>[] = [
    {
      key: "occurredAt",
      header: t("colOccurredAt"),
      width: WIDTHS.occurredAt,
      cell: (row) => (
        <Text size="2" color="gray">
          {format.dateTime(row.occurredAt, {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: TIME_ZONE,
          })}
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
            items={[
              {
                key: "details",
                label: t("viewDetails"),
                onSelect: () => setDetailsId(row.id),
              },
              {
                key: "copy",
                label:
                  copiedId === row.id
                    ? t("recordIdCopied")
                    : t("copyRecordId"),
                onSelect: () => copyRecordId(row),
              },
            ]}
          />
        </Flex>
      ),
    },
  ];

  return (
    <>
      <DataTable
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.id)}
        minWidth={MIN_WIDTH}
        empty={empty}
        footer={
          pageCount > 1 && (
            <TablePagination
              caption={t("pageStatus", { page, pages: pageCount })}
              onPrev={page > 1 ? onPrev : undefined}
              onNext={page < pageCount ? onNext : undefined}
              prevLabel={t("previousPage")}
              nextLabel={t("nextPage")}
            />
          )
        }
      />

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
