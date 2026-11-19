"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cardFront } from "@/lib/log/card";
import { onRecordChanged } from "@/lib/log/record-changed";
import { readWordStudy } from "@/lib/log/summary";
import type { WordAnswer } from "@/lib/dictionary/lookup";
import { answerRanked, answerSenses, pickSense } from "@/lib/review/sense";
import type { SuggestRow } from "@/components/ui";

// Rows the panel under the field draws: the panel is a list to glance at, not the dictionary's ten.
const ROWS_SHOWN = 6;

// The gloss a row carries is the lead of the sense the entry itself opens with (RL-91's default sense),
// so the panel never says a different thing than the answer it opens.
function leadGloss(answer: WordAnswer): string | null {
  const sense = pickSense(answerSenses(answer), null, answerRanked(answer));
  return sense?.translations[0] ?? null;
}

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
  // Glosses outlive a keystroke: only a candidate not met before is looked up.
  const [glosses, setGlosses] = useState<ReadonlyMap<string, string | null>>(new Map());
  const known = useRef(glosses);
  useEffect(() => {
    known.current = glosses;
  }, [glosses]);
  const [searched, setSearched] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (key === "") return;
    let live = true;
    const fresh = key.split("\n").filter((word) => !known.current.has(word));
    if (fresh.length === 0) return;
    Promise.all(
      fresh.map(async (word) => [word, leadGloss(await lookup(word))] as const),
    )
      .then((pairs) => {
        if (!live) return;
        setGlosses((current) => new Map([...current, ...pairs]));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, lookup]);

  // The words the reader has searched: built once the panel has rows, and again whenever the record changes.
  const wanted = key !== "";
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    function read(): void {
      readWordStudy()
        .then(({ rows }) => {
          if (live) setSearched(new Set(rows.map((row) => String(cardFront(row)).toLowerCase())));
        })
        .catch(() => {});
    }
    read();
    const off = onRecordChanged(read);
    return () => {
      live = false;
      off();
    };
  }, [wanted]);

  return shown.map((word) => ({
    key: word,
    word,
    gloss: glosses.get(word) ?? null,
    note: word.includes(" ") ? t("phraseNote") : searched?.has(word.toLowerCase()) ? t("searchedBefore") : null,
  }));
}
