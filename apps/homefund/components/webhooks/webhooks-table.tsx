"use client";

import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";

import {
  Badge,
  DataTable,
  Flex,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { WebhookCredentialRow } from "@/db/queries/webhook-credentials";
import { TIME_ZONE } from "@/lib/locales";

// The tracks of the Webhooks artboard, in order (credencial, límite, último
// uso, creada, menú).
const WIDTHS = {
  credential: "minmax(0, 1fr)",
  limit: "170px",
  lastUsed: "150px",
  created: "140px",
  menu: "110px",
} as const;

/**
 * The dense Webhooks of `private/design-desktop/Webhooks.dc.html` (RF-86).
 * `WebhookCredentialRow` never carries `tokenHash` — the query does not select
 * it and the grant does not exist — so no cell here can leak one; only
 * `issueWebhookCredential`'s own return, shown once in the untouched dialog,
 * ever holds the raw bearer.
 */
export function WebhooksTable({
  rows,
  empty,
  onRevoke,
}: {
  rows: WebhookCredentialRow[];
  empty?: ReactNode;
  onRevoke: (row: WebhookCredentialRow) => void;
}) {
  const t = useTranslations("webhooks");
  const format = useFormatter();

  function formatDate(value: Date): string {
    return format.dateTime(value, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: TIME_ZONE,
    });
  }

  const columns: DataColumn<WebhookCredentialRow>[] = [
    {
      key: "credential",
      header: t("columnCredential"),
      width: WIDTHS.credential,
      cell: (row) => (
        <Flex align="center" gap="2" wrap="wrap" minWidth="0">
          <Text
            size="2"
            weight="medium"
            color={row.revokedAt ? "gray" : undefined}
            truncate
          >
            {row.name}
          </Text>
          {row.revokedAt !== null && (
            <Badge color="gray">{t("revokedBadge")}</Badge>
          )}
        </Flex>
      ),
    },
    {
      key: "limit",
      header: t("columnLimit"),
      width: WIDTHS.limit,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Text size="2" color="gray">
          {t("rateLimit", { count: row.rateLimitPerMin })}
        </Text>
      ),
    },
    {
      key: "lastUsed",
      header: t("columnLastUsed"),
      width: WIDTHS.lastUsed,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Text size="2" color="gray">
          {row.lastUsedAt ? formatDate(row.lastUsedAt) : t("neverUsedShort")}
        </Text>
      ),
    },
    {
      key: "created",
      header: t("columnCreated"),
      width: WIDTHS.created,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Text size="2" color="gray">
          {formatDate(row.createdAt)}
        </Text>
      ),
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      // A revoked credential has nothing left to act on.
      cell: (row) =>
        row.revokedAt === null ? (
          <RowMenu
            rowName={row.name}
            items={[
              {
                key: "revoke",
                label: t("revoke"),
                tone: "danger",
                onSelect: () => onRevoke(row),
              },
            ]}
          />
        ) : null,
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
