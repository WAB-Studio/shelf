"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cardFront } from "@/lib/log/anki";
import { readWordStudy } from "@/lib/log/summary";
import { Box, Button, Card, Flex, MetaLabel } from "@/components/ui";

const RECENT_SHOWN = 6;
const EXAMPLE_KEYS = ["one", "two", "three", "four"] as const;

// What the empty box offers instead of a blank page: the reader's own latest searches once there
// are any, a few examples before that. A tap fills the box as typing would.
export function Starters({ onPick }: { onPick: (text: string) => void }) {
  const t = useTranslations("search");
  const [recent, setRecent] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    readWordStudy()
      .then(({ rows }) => {
        if (!live) return;
        const latest = rows
          .filter((row) => row.pending !== true)
          .sort((a, b) => b.lastAt - a.lastAt)
          .slice(0, RECENT_SHOWN)
          .map(cardFront)
          // A row whose text is not a string would make the whole screen throw; it is simply not offered.
          .filter((word): word is string => typeof word === "string");
        setRecent(latest);
      })
      .catch(() => {
        if (live) setRecent([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (recent === null) return null;
  const words = recent.length > 0 ? recent : EXAMPLE_KEYS.map((key) => t(`examples.${key}`));

  // From 1024px the side column lists the reader's own latest searches, so the card gives way there.
  return (
    <Box display={recent.length > 0 ? { initial: "block", md: "none" } : "block"}>
    <Card>
      <Flex direction="column" gap="3">
        <MetaLabel>{t(recent.length > 0 ? "recentTitle" : "tryTitle")}</MetaLabel>
        <Flex gap="2" wrap="wrap">
          {words.map((word) => (
            <Button key={word} size="2" variant="soft" lang="en" onClick={() => onPick(word)}>
              {word}
            </Button>
          ))}
        </Flex>
      </Flex>
    </Card>
    </Box>
  );
}
