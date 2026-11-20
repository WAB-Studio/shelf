"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { deviceZone, yearWhenDifferent } from "@/lib/format/zone";
import { onRecordChanged } from "@/lib/log/record-changed";
import { readWordStory, type WordStory } from "@/lib/log/story";
import { dueWhen } from "@/lib/review/schedule";
import { readCards } from "@/lib/review/store";
import { Flex, Link, MarkedWord, MetaLabel, Separator, TapTarget, Text } from "@/components/ui";

type Review = { kind: "new" } | { kind: "due" } | { kind: "later"; due: number; when: "today" | "tomorrow" | "later" };

// The second panel of an answer on a wide screen: what the reader's own record says of this word.
// Free and offline: it reads the device's record and review, and asks no one.
export function WordStoryPanel({ headword }: { headword: string }) {
  const t = useTranslations("story");
  const format = useFormatter();
  const timeZone = deviceZone();
  const [openedAt] = useState(() => Date.now());
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
    const off = onRecordChanged(read);
    return () => {
      live = false;
      off();
    };
  }, [headword]);

  if (story === null) return null;

  return (
    <Flex direction="column" gap="4">
      <Separator size="4" />
      <Flex direction="column" gap="1">
        <MetaLabel>{t("title")}</MetaLabel>
        <Text serif size="5" weight="bold">
          {story.times === 0 ? t("neverSearched") : t("searched", { count: story.times })}
        </Text>
        {story.firstAt !== null && (
          <Text size="2" muted>
            {t("first", { date: format.dateTime(story.firstAt, { day: "numeric", month: "long", timeZone, ...yearWhenDifferent(story.firstAt, openedAt, timeZone) }) })}
          </Text>
        )}
        <Text size="2" muted>
          {review.kind === "new"
            ? t("reviewNew")
            : review.kind === "due"
              ? t("reviewDue")
              : t("reviewLater", {
                  when: review.when,
                  date: format.dateTime(review.due, { day: "numeric", month: "long", timeZone, ...yearWhenDifferent(review.due, openedAt, timeZone) }),
                })}
        </Text>
        <Link asChild>
          <NextLink href={`/repaso?palabra=${encodeURIComponent(headword)}`} prefetch={false}>
            <TapTarget align="center">
              <Text size="2" weight="bold">{t("reviewOnly")}</Text>
            </TapTarget>
          </NextLink>
        </Link>
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
    </Flex>
  );
}
