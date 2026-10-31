"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { contentUnit } from "@/lib/log/outcome";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, isReviewable } from "@/lib/review/deck";
import { readCards } from "@/lib/review/store";
import { Button, Card, Figure, Flex, Text } from "@/components/ui";

type Due = { due: number; unit: "words" | "phrases" | "entries" };

// What waits in the review today, as a figure on the main screen at every width: the way into the
// review for a reader on a phone, where the bar carries no counts. Draws nothing until the record is read,
// and nothing for a record with no entry to review.
export function ReviewCard() {
  const t = useTranslations("review");
  const [due, setDue] = useState<Due | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([readWordStudy(), readCards()])
      .then(([{ rows }, cards]) => {
        if (!live) return;
        const reviewable = rows.filter(isReviewable);
        if (reviewable.length === 0) return;
        setDue({ due: buildQueue(rows, cards, Date.now()).items.length, unit: contentUnit(reviewable) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (due === null) return null;

  return (
    <Card tone="tint">
      <Flex direction="column" gap="4" align="start">
        {due.due > 0 ? (
          <>
            <Figure size="hero" value={due.due} label={t("dueToday", { count: due.due, kind: due.unit })} />
            <Button asChild size="3">
              <NextLink href="/repaso" prefetch={false}>{t("reviewNowHome")}</NextLink>
            </Button>
          </>
        ) : (
          <Text size="3">{t("sideNone")}</Text>
        )}
      </Flex>
    </Card>
  );
}
