"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { cardFront } from "@/lib/log/card";
import { readWordStudy } from "@/lib/log/summary";
import type { WordAnswer } from "@/lib/dictionary/lookup";
import type { SuggestRow } from "@/components/ui";

// Rows the panel under the field draws: the panel is a list to glance at, not the dictionary's ten.
const ROWS_SHOWN = 6;

// Headwords that begin with the string being typed, offered while it is still being treated as a word
// (RL-18), each with its main translation and a quiet note: a phrase, or a word the reader searched
// before. Empty when there is nothing to offer, so an empty prefix never leaves a hollow panel.
export function useSuggestionRows(
  items: readonly string[],
  lookup: (text: string) => Promise<WordAnswer>,
): SuggestRow[] {
  const t = useTranslations("search");
  const shown = items.slice(0, ROWS_SHOWN);
  const key = shown.join("\n");
  const [glosses, setGlosses] = useState<{ key: string; byWord: Map<string, string> }>({ key: "", byWord: new Map() });
  const [searched, setSearched] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (key === "") return;
    let live = true;
    Promise.all(
      key.split("\n").map(async (word) => {
        const answer = await lookup(word).catch(() => null);
        return [word, answer?.exact?.senses[0]?.translations[0] ?? null] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      const byWord = new Map<string, string>();
      for (const [word, gloss] of pairs) if (gloss !== null) byWord.set(word, gloss);
      setGlosses({ key, byWord });
    });
    readWordStudy()
      .then(({ rows }) => {
        if (live) setSearched(new Set(rows.map((row) => String(cardFront(row)).toLowerCase())));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, lookup]);

  return shown.map((word) => ({
    key: word,
    word,
    gloss: glosses.key === key ? (glosses.byWord.get(word) ?? null) : null,
    note: word.includes(" ") ? t("phraseNote") : searched.has(word) ? t("searchedBefore") : null,
  }));
}
