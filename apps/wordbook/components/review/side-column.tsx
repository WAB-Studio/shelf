"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { cardFront } from "@/lib/log/anki";
import { contentUnit } from "@/lib/log/outcome";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, isReviewable } from "@/lib/review/deck";
import { readCards } from "@/lib/review/store";
import { Button, Card, Figure, Flex, Link, MetaLabel, TapTarget, Text } from "@/components/ui";

const RECENT_SHOWN = 8;

type Side = { due: number; unit: "words" | "phrases" | "entries"; recent: string[] };

// The desktop's side column: what waits in the review today and the reader's latest searches, so a
// wide screen carries more than one narrow column (docs/wordbook/DESIGN.md "Viewport"). `review`
// drops the review card on the screen that is the review.
export function SideColumn({ section }: { section: "search" | "review" }) {
  const t = useTranslations("review");
  const tSearch = useTranslations("search");
  const [side, setSide] = useState<Side | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([readWordStudy(), readCards()])
      .then(([{ rows }, cards]) => {
        if (!live) return;
        setSide({
          due: buildQueue(rows, cards, Date.now()).items.length,
          unit: contentUnit(rows.filter(isReviewable)),
          recent: rows
            .filter((row) => row.pending !== true)
            .sort((a, b) => b.lastAt - a.lastAt)
            .slice(0, RECENT_SHOWN)
            .map(cardFront)
            .filter((word): word is string => typeof word === "string"),
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (side === null) return null;

  return (
    <>
      {section === "search" && (
        <Card>
          <Flex direction="column" gap="3" align="start">
            <MetaLabel>{t("sideTitle")}</MetaLabel>
            {side.due > 0 ? (
              <>
                <Figure value={side.due} label={t("dueUnit", { count: side.due, kind: side.unit })} />
                <Button asChild size="2" variant="soft">
                  <NextLink href="/repaso">{t("open")}</NextLink>
                </Button>
              </>
            ) : (
              <Text size="2" muted>
                {t("sideNone")}
              </Text>
            )}
          </Flex>
        </Card>
      )}
      {side.recent.length > 0 && (
        <Card>
          <Flex direction="column" gap="1" align="start">
            <MetaLabel>{tSearch("recentTitle")}</MetaLabel>
            {side.recent.map((word) => (
              <Link key={word} asChild underline="none">
                <NextLink href={`/?q=${encodeURIComponent(word)}`} prefetch={false} lang="en">
                  <TapTarget align="center">{word}</TapTarget>
                </NextLink>
              </Link>
            ))}
          </Flex>
        </Card>
      )}
    </>
  );
}
