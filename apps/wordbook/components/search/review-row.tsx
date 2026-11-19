"use client";

import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { useDueToday } from "@/lib/review/use-due-today";
import { Button, PillRow, Text } from "@/components/ui";

// What waits in the review today, in one pill at the top of the margin: the count and the way in.
// Draws nothing until the record is read, and nothing for a record with no entry to review; a quiet
// line says so when everything is done.
export function ReviewRow() {
  const t = useTranslations("review");
  const due = useDueToday();

  if (due === null) return null;
  if (due.due === 0) {
    return (
      <Text size="2" muted>
        {t("sideNone")}
      </Text>
    );
  }

  return (
    <PillRow
      action={
        <Button asChild size="3">
          <NextLink href="/repaso" prefetch={false}>
            {t("start")}
          </NextLink>
        </Button>
      }
    >
      <Text weight="bold">{due.due}</Text> <Text muted>{t("dueToday", { count: due.due, kind: due.unit })}</Text>
    </PillRow>
  );
}
