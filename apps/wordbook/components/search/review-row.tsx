"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { LOG_DELETED_EVENT } from "@/lib/log/delete";
import { LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import { contentUnit } from "@/lib/log/outcome";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, isReviewable } from "@/lib/review/deck";
import { readCards } from "@/lib/review/store";
import { Button, PillRow, Text } from "@/components/ui";

type Due = { due: number; unit: "words" | "phrases" | "entries" };

// What waits in the review today, in one pill at the top of the margin: the count and the way in.
// Draws nothing until the record is read, and nothing for a record with no entry to review; a quiet
// line says so when everything is done.
export function ReviewRow() {
  const t = useTranslations("review");
  const [due, setDue] = useState<Due | null>(null);

  useEffect(() => {
    let live = true;
    function read(): void {
      Promise.all([readWordStudy(), readCards()])
        .then(([{ rows }, cards]) => {
          if (!live) return;
          const reviewable = rows.filter(isReviewable);
          if (reviewable.length === 0) {
            setDue(null);
            return;
          }
          setDue({ due: buildQueue(rows, cards, Date.now()).items.length, unit: contentUnit(reviewable) });
        })
        .catch(() => {});
    }
    read();
    // The margin stays mounted while the reader searches, deletes or syncs: the count follows the record.
    const events = [LOG_DELETED_EVENT, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT, SYNC_LANDED_EVENT];
    for (const name of events) window.addEventListener(name, read);
    return () => {
      live = false;
      for (const name of events) window.removeEventListener(name, read);
    };
  }, []);

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
