"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cardFront } from "@/lib/log/anki";
import { isPhraseRow } from "@/lib/log/outcome";
import { readWordStory } from "@/lib/log/story";
import { readWordStudy } from "@/lib/log/summary";
import { splitTranslations } from "@/lib/log/translation-line";
import { Button, Card, Flex, MetaLabel, Mosaic, Tile } from "@/components/ui";

// One large tile and eight small ones fill two columns on a phone and three on a desktop with no gap.
const RECENT_SHOWN = 9;

type Recent = { word: string; gloss: string | null; phrase: boolean };
const EXAMPLE_KEYS = ["one", "two", "three", "four"] as const;

// What the empty box offers instead of a blank page: the reader's own latest searches once there
// are any, a few examples before that. A tap fills the box as typing would.
export function Starters({ onPick }: { onPick: (text: string) => void }) {
  const t = useTranslations("search");
  const [recent, setRecent] = useState<Recent[] | null>(null);
  // What the large tile adds under its word: the reader's own phrase holding it, else nothing.
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readWordStudy()
      .then(({ rows }) => {
        if (!live) return;
        const latest = rows
          .filter((row) => row.pending !== true)
          .sort((a, b) => b.lastAt - a.lastAt)
          .slice(0, RECENT_SHOWN)
          .map((row): Recent => ({ word: cardFront(row), gloss: isPhraseRow(row) ? null : (splitTranslations(row.lastTranslation ?? "")[0] ?? null), phrase: isPhraseRow(row) }))
          // A row whose text is not a string would make the whole screen throw; it is simply not offered.
          .filter((entry) => typeof entry.word === "string");
        setRecent(latest);
      })
      .catch(() => {
        if (live) setRecent([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // A phrase is its own text already: only a word gets a phrase of the reader's under it.
  const lead = recent?.[0]?.phrase === false ? recent[0].word : undefined;
  useEffect(() => {
    if (lead === undefined) return;
    let live = true;
    readWordStory(lead)
      .then((story) => {
        if (live) setNote(story.phrases[0] ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lead]);

  if (recent === null) return null;

  if (recent.length > 0) {
    return (
      <Flex direction="column" gap="3">
        <MetaLabel>{t("recentTitle")}</MetaLabel>
        <Mosaic>
          {recent.map(({ word, gloss }, index) => (
            <Tile key={word} word={word} gloss={gloss} big={index === 0 && note !== null} note={index === 0 ? note : null} onClick={() => onPick(word)} />
          ))}
        </Mosaic>
      </Flex>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="3">
        <MetaLabel>{t("tryTitle")}</MetaLabel>
        <Flex gap="2" wrap="wrap">
          {EXAMPLE_KEYS.map((key) => t(`examples.${key}`)).map((word) => (
            <Button key={word} size="2" variant="soft" lang="en" onClick={() => onPick(word)}>
              {word}
            </Button>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}
