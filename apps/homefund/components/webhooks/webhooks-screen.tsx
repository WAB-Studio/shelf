"use client";

import { EllipsisVertical, Plus, Webhook } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { revokeWebhookCredentialAction } from "@/app/actions/webhook-credentials";
import { WebhookCredentialDialog } from "@/components/webhooks/webhook-credential-dialog";
import { WebhooksTable } from "@/components/webhooks/webhooks-table";
import {
  Badge,
  Box,
  Button,
  Card,
  ConfirmDialog,
  CopyField,
  DropdownMenu,
  EmptyState,
  Flex,
  Heading,
  IconButton,
  ScreenHeader,
  Text,
} from "@/components/ui";
import type {
  WebhookCredentialOptions,
  WebhookCredentialRow,
} from "@/db/queries/webhook-credentials";
import { TIME_ZONE } from "@/lib/locales";
import { useActionErrorToast } from "@/lib/use-action-toast";

// The wire contract, not copy: these keys and values are what the ingest route
// parses, so they stay in English in every language.
function requestSample(ingestUrl: string): string {
  return [
    `POST ${ingestUrl}`,
    "Authorization: Bearer whk_...",
    "Content-Type: application/json",
    "",
    "{",
    '  "text": "...",',
    '  "external_ref": "...",',
    '  "amount": "0",',
    '  "occurred_at": "2026-01-31",',
    '  "account_id": "...",',
    '  "direction": "expense"',
    "}",
  ].join("\n");
}

/**
 * The webhook credentials screen (RF-86). A credential is issued, read and
 * revoked here and never edited: its bearer is shown once, so changing anything
 * means revoking and issuing again. A revoked row stays listed with its badge,
 * so a person sees the revocation took effect.
 */
export function WebhooksScreen({
  credentials,
  options,
  ingestUrl,
}: {
  credentials: WebhookCredentialRow[];
  options: WebhookCredentialOptions;
  ingestUrl: string;
}) {
  const t = useTranslations("webhooks");
  // Root-scoped: `common`'s labels are full catalogue paths.
  const tKey = useTranslations();
  const format = useFormatter();

  const [issuing, setIssuing] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  const onActionError = useActionErrorToast();

  const revoke = useAction(revokeWebhookCredentialAction, {
    onSuccess() {
      toast.success(t("revokeDone"));
      setRevokeTarget(null);
    },
    onError: onActionError,
  });

  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));
  const categoryNames = new Map(options.categories.map((c) => [c.id, c.name]));

  function formatDate(value: Date): string {
    return format.dateTime(value, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: TIME_ZONE,
    });
  }

  // A default the caller can no longer read — an archived account, another
  // scope's category — drops its line rather than showing a raw id.
  function defaultLines(row: WebhookCredentialRow): string[] {
    const lines: string[] = [];
    const account = row.defaultAccountId && accountNames.get(row.defaultAccountId);
    const category =
      row.defaultCategoryId && categoryNames.get(row.defaultCategoryId);
    if (account) lines.push(t("defaultAccount", { name: account }));
    if (category) lines.push(t("defaultCategory", { name: category }));
    return lines;
  }

  const issueButton = (
    <Button type="button" onClick={() => setIssuing(true)}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  return (
    <Flex direction="column" gap="4">
      {/* The laptop's band and table, and the phone's header and cards:
          exactly one set is displayed at any width. */}
      <Box display={{ initial: "none", lg: "block" }}>
        <Flex direction="column" gap="4">
          <ScreenHeader
            title={t("title")}
            meta={t("listMeta", { count: credentials.length })}
            actions={credentials.length > 0 && issueButton}
          />

          <WebhooksTable
            rows={credentials}
            empty={
              credentials.length === 0 ? (
                <EmptyState
                  icon={<Webhook size={40} />}
                  title={t("emptyTitle")}
                  description={t("emptyDescription")}
                  action={issueButton}
                />
              ) : undefined
            }
            onRevoke={(row) => setRevokeTarget(row.id)}
          />
        </Flex>
      </Box>

      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="4">
          <Flex justify="between" align="center" gap="3" wrap="wrap">
            <Heading size="5">{t("title")}</Heading>
            {credentials.length > 0 && issueButton}
          </Flex>

          {credentials.length === 0 ? (
            <EmptyState
              icon={<Webhook size={40} />}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={issueButton}
            />
          ) : (
            <Flex direction="column" gap="2">
              {credentials.map((row) => {
                const lines = defaultLines(row);
                return (
                  <Card key={row.id}>
                    <Flex justify="between" align="start" gap="3">
                      <Flex direction="column" minWidth="0">
                        <Flex align="center" gap="2" wrap="wrap">
                          <Text weight="medium" truncate>
                            {row.name}
                          </Text>
                          {row.revokedAt !== null && (
                            <Badge color="gray">{t("revokedBadge")}</Badge>
                          )}
                        </Flex>
                        <Text size="2" color="gray">
                          {t("rateLimit", { count: row.rateLimitPerMin })}
                        </Text>
                        {lines.length === 0 ? (
                          <Text size="2" color="gray">
                            {t("defaultsNone")}
                          </Text>
                        ) : (
                          lines.map((line) => (
                            <Text key={line} size="2" color="gray">
                              {line}
                            </Text>
                          ))
                        )}
                        <Text size="2" color="gray">
                          {row.lastUsedAt
                            ? t("lastUsed", { date: formatDate(row.lastUsedAt) })
                            : t("neverUsed")}
                        </Text>
                        <Text size="2" color="gray">
                          {t("issuedOn", { date: formatDate(row.createdAt) })}
                        </Text>
                      </Flex>
                      {/* A revoked credential has nothing left to act on. */}
                      {row.revokedAt === null && (
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <IconButton
                              type="button"
                              variant="ghost"
                              color="gray"
                              size="3"
                              aria-label={tKey("common.actionsFor", {
                                name: row.name,
                              })}
                            >
                              <EllipsisVertical size={16} />
                            </IconButton>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content>
                            <DropdownMenu.Item
                              color="red"
                              onSelect={() => setRevokeTarget(row.id)}
                            >
                              {t("revoke")}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      )}
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}
        </Flex>
      </Box>

      {/* Shown even with no credential: a person reads what a delivery looks
          like before deciding to issue one. */}
      <Card>
        <Flex direction="column" gap="4">
          <Heading as="h2" size="3">{t("endpointHeading")}</Heading>
          <CopyField
            id="webhook-endpoint-url"
            label={t("endpointUrlLabel")}
            value={ingestUrl}
            copyLabel={t("copy")}
            copiedLabel={t("copied")}
            failedLabel={t("copyFailed")}
          />
          <CopyField
            id="webhook-endpoint-request"
            label={t("endpointRequestLabel")}
            value={requestSample(ingestUrl)}
            copyLabel={t("copy")}
            copiedLabel={t("copied")}
            failedLabel={t("copyFailed")}
            multiline
          />
          <Text size="2" color="gray">
            {t("endpointFieldsDescription")}
          </Text>
        </Flex>
      </Card>

      <WebhookCredentialDialog
        open={issuing}
        onOpenChange={setIssuing}
        options={options}
      />

      {revokeTarget !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          title={t("revokeTitle")}
          description={t("revokeDescription")}
          confirmLabel={t("revoke")}
          cancelLabel={tKey("common.cancel")}
          tone="danger"
          pending={revoke.isPending}
          onConfirm={() => revoke.execute({ id: revokeTarget })}
        />
      )}
    </Flex>
  );
}
