"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { restoreShapeAction } from "@/app/actions/ingest";
import {
  Button,
  Card,
  Flex,
  Heading,
  Separator,
  Text,
} from "@/components/ui";
import type { SilencedShapeRow } from "@/db/queries/ingest-review";
import { TIME_ZONE } from "@/lib/locales";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * The shapes a person silenced, and the one control that undoes a silence
 * (RF-99). No confirmation: returning a shape to the queue destroys nothing a
 * person authored, and the next message of that shape can be silenced again in
 * one tap.
 */
export function SilencedShapes({ shapes }: { shapes: SilencedShapeRow[] }) {
  const t = useTranslations("ingest");
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  const [openIds, setOpenIds] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const restore = useAction(restoreShapeAction, {
    onSuccess({ data }) {
      const count = data?.deliveriesRestored ?? 0;
      toast.success(
        count > 0 ? t("restoredWithDeliveries", { count }) : t("restoredToast"),
      );
    },
    onError: onActionError,
    onSettled() {
      setPendingId(null);
    },
  });

  // Nothing silenced, nothing to say: the inbox stays as it was.
  if (shapes.length === 0) return null;

  function toggle(shapeId: string): void {
    setOpenIds((ids) =>
      ids.includes(shapeId)
        ? ids.filter((id) => id !== shapeId)
        : [...ids, shapeId],
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <Heading size="3">{t("silencedTitle")}</Heading>
          <Text size="2" color="gray">
            {t("silencedCount", { count: shapes.length })}
          </Text>
        </Flex>

        {shapes.map((shape, index) => {
          const open = openIds.includes(shape.id);

          return (
            <Flex key={shape.id} direction="column" gap="2">
              {index > 0 && <Separator size="4" />}

              <Text truncate>{shape.sampleText}</Text>
              <Text size="2" color="gray">
                {t("silencedOn", {
                  date: format.dateTime(shape.createdAt, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    timeZone: TIME_ZONE,
                  }),
                })}
              </Text>
              {shape.silencedCount > 0 && (
                <Text size="2" color="gray">
                  {t("silencedWaiting", { count: shape.silencedCount })}
                </Text>
              )}

              <Flex align="center" gap="2" wrap="wrap">
                <Button
                  type="button"
                  size="2"
                  variant="soft"
                  disabled={pendingId === shape.id}
                  onClick={() => {
                    setPendingId(shape.id);
                    restore.execute({ shapeId: shape.id });
                  }}
                >
                  {t("restore")}
                </Button>
                <Button
                  type="button"
                  size="2"
                  variant="ghost"
                  color="gray"
                  onClick={() => toggle(shape.id)}
                >
                  {open ? t("hideRawText") : t("showRawText")}
                </Button>
              </Flex>

              {open && (
                <Flex direction="column" gap="1">
                  <Text size="2" weight="medium">
                    {t("rawTextLabel")}
                  </Text>
                  <Text
                    size="2"
                    color="gray"
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {shape.sampleText}
                  </Text>
                </Flex>
              )}
            </Flex>
          );
        })}
      </Flex>
    </Card>
  );
}
