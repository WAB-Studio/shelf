import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

import type { DictionaryPayload } from "@/lib/dictionary/format";
import { buildIndex, type DictionaryIndex } from "@/lib/dictionary/index-build";

const DICTIONARY_ASSET = path.join(
  process.cwd(),
  "public",
  "dictionary",
  "eng-spa-2025.11.23.json",
);

// The 8 MiB asset the client installs, parsed once per server process for
// every route that reads it, never once per route.
let dictionaryIndex: DictionaryIndex | null = null;

export function loadDictionaryIndex(): DictionaryIndex {
  if (!dictionaryIndex) {
    const payload = JSON.parse(readFileSync(DICTIONARY_ASSET, "utf8")) as DictionaryPayload;
    dictionaryIndex = buildIndex(payload);
  }
  return dictionaryIndex;
}
