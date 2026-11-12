"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Card, Flex, Heading, RawText, Separator, Text } from "@/components/ui";
import type { RefusedDeliveryRow } from "@/db/queries/ingest-review";
import { TIME_ZONE } from "@/lib/locales";

/**
 * The messages the channel refused before any person saw them (RF-196), each with
 * why: nothing is lost, and nothing waits in the queue.
 */
export function RefusedDeliveries({ rows }: { rows: RefusedDeliveryRow[] }) {
  const t = useTranslations("ingest");
  const format = useFormatter();

  if (rows.length === 0) return null;

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <Heading size="3">{t("refusedTitle")}</Heading>
          <Text size="2" color="gray">
            {t("refusedCount", { count: rows.length })}
          </Text>
        </Flex>

        {rows.map((row, index) => (
          <Flex key={row.id} direction="column" gap="1">
            {index > 0 && <Separator size="4" />}
            {/* In full: a confirmation code from Google sits in this text and has to be readable. */}
            <RawText>{row.rawText}</RawText>
            <Text size="2" color="gray">
              {t("refusedMeta", {
                reason: t(`rejectReason.${row.rejectReason}`),
                date: format.dateTime(row.createdAt, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  timeZone: TIME_ZONE,
                }),
              })}
            </Text>
          </Flex>
        ))}
      </Flex>
    </Card>
  );
}
