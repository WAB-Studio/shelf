"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { LOG_DELETED_EVENT } from "@/lib/log/delete";
import { LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { readWordStory, type WordStory } from "@/lib/log/story";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import { dueWhen } from "@/lib/review/schedule";
import { readCards } from "@/lib/review/store";
import { Button, Card, Flex, MarkedWord, MetaLabel, Separator, Text } from "@/components/ui";

type Review = { kind: "new" } | { kind: "due" } | { kind: "later"; due: number; when: "today" | "tomorrow" | "later" };

// The second panel of an answer on a wide screen: what the reader's own record says of this word.
// Free and offline: it reads the device's record and review, and asks no one.
export function WordStoryPanel({ headword }: { headword: string }) {
  const t = useTranslations("story");
  const format = useFormatter();
  const [story, setStory] = useState<WordStory | null>(null);
  const [review, setReview] = useState<Review>({ kind: "new" });

  useEffect(() => {
    let live = true;
    function read() {
      Promise.all([readWordStory(headword), readCards()])
        .then(([next, cards]) => {
          if (!live) return;
          const card = cards.find((entry) => entry.key === headword);
          setStory(next);
          const now = Date.now();
          setReview(
            card === undefined
              ? { kind: "new" }
              : card.due <= now
                ? { kind: "due" }
                : { kind: "later", due: card.due, when: dueWhen(card.due, now) },
          );
        })
        .catch(() => {});
    }
    read();
    // The lookup that opened this answer lands in the record a moment later; a delete, a wipe or a pull
    // from another device changes it the same way.
    const events = [LOG_FLUSHED_EVENT, LOG_DELETED_EVENT, LOG_CLEARED_EVENT, SYNC_LANDED_EVENT];
    for (const name of events) window.addEventListener(name, read);
    return () => {
      live = false;
      for (const name of events) window.removeEventListener(name, read);
    };
  }, [headword]);

  if (story === null) return null;

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <MetaLabel>{t("title")}</MetaLabel>
          <Text variant="translation">
            {story.times === 0 ? t("neverSearched") : t("searched", { count: story.times })}
          </Text>
          {story.firstAt !== null && (
            <Text size="2" muted>
              {t("first", { date: format.dateTime(story.firstAt, { day: "numeric", month: "long", year: "numeric" }) })}
            </Text>
          )}
        </Flex>
        <Separator size="4" />
        <Flex direction="column" gap="2">
          <MetaLabel>{t("phrasesTitle")}</MetaLabel>
          {story.phrases.length === 0 ? (
            <Text size="2" muted>
              {t("noPhrases")}
            </Text>
          ) : (
            story.phrases.map((phrase) => (
              <Text key={phrase} size="3" english>
                <MarkedWord text={phrase} forms={story.forms} />
              </Text>
            ))
          )}
        </Flex>
        <Separator size="4" />
        <Flex direction="column" gap="3" align="start">
          <Text size="2" muted>
            {review.kind === "new"
              ? t("reviewNew")
              : review.kind === "due"
                ? t("reviewDue")
                : t("reviewLater", {
                    when: review.when,
                    date: format.dateTime(review.due, { day: "numeric", month: "long" }),
                  })}
          </Text>
          <Button asChild size="3" variant="soft">
            <NextLink href={`/repaso?palabra=${encodeURIComponent(headword)}`} prefetch={false}>
              {t("reviewNow")}
            </NextLink>
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}
