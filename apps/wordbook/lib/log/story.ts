import { splitAroundWord } from "@/lib/word/mark-word";
import { openLookups, readAll } from "./record";
import type { LookupRecord } from "./types";

type Row = Pick<LookupRecord, "kind" | "headword" | "normalised" | "text" | "at">;

// What the record says of one word: how often it was looked up, since when, and the sentences the
// reader looked up that contain it (the only examples that cost nothing and work offline).
export type WordStory = {
  times: number;
  firstAt: number | null;
  // The reader's own phrases, newest first, each once.
  phrases: string[];
  // The spellings the word was searched under, for setting it apart inside a phrase.
  forms: string[];
};

const PHRASES_SHOWN = 4;

export function buildWordStory(rows: readonly Row[], key: string): WordStory {
  const own = rows.filter((row) => row.kind === "word" && (row.headword === key || row.normalised === key));
  const forms = [...new Set([key, ...own.map((row) => row.normalised)])];
  const seen = new Set<string>();
  const phrases = rows
    .filter((row) => row.kind === "phrase" && splitAroundWord(row.text, forms).some((piece) => piece.hit))
    .sort((a, b) => b.at - a.at)
    .filter((row) => {
      const id = row.text.trim().toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, PHRASES_SHOWN)
    .map((row) => row.text.trim());
  return {
    times: own.length,
    firstAt: own.length === 0 ? null : Math.min(...own.map((row) => row.at)),
    phrases,
    forms,
  };
}

export async function readWordStory(key: string): Promise<WordStory> {
  return buildWordStory([...(await readAll()), ...openLookups()], key);
}
