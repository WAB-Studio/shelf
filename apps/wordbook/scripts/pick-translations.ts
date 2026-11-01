/**
 * One paid, offline pass over the dictionary's gloss lists: for every entry with several translations a small
 * model picks the one a Spanish speaker gives first and the next two most useful, copied verbatim from the
 * list. The picks are committed in `translation-picks.json`; `translation-order.ts` reads them at build and
 * nothing else ever calls a model for this: CI, `dict:build` and the tests read the committed file.
 *
 * Run by hand, whenever the source or the picks need renewing:
 *   node --import tsx --env-file=<file with OPENAI_API_KEY> scripts/pick-translations.ts [--limit N] [--dry]
 *
 * Cached: an entry whose picks are already in the file, and still name glosses the entry carries, is never
 * asked again, so a rerun after an interruption or a new source costs only what is missing. The entries go
 * commonest first (single-word headwords, the most glosses first, since the source carries no English
 * frequency) in batches of BATCH entries, and the file is written after every batch.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DICTIONARY_DIR, manifestSchema, type DictionaryPayload } from "../lib/dictionary/format";
import { pickKey } from "./translation-order";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const PICKS_PATH = path.join(import.meta.dirname, "translation-picks.json");
const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.PICK_MODEL ?? "gpt-5-mini";
const BATCH = 40;
const PARALLEL = 8;
const PICKS_PER_ENTRY = 3;

type Picks = Record<string, string[]>;
type Item = { key: string; headword: string; pos: string; glosses: string[] };

function readPicks(): Picks {
  return JSON.parse(readFileSync(PICKS_PATH, "utf8")) as Picks;
}

function writePicks(picks: Picks): void {
  const sorted = Object.fromEntries(Object.entries(picks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(PICKS_PATH, JSON.stringify(sorted, null, 0).replace(/\],"/g, '],\n"') + "\n");
}

// A cached pick stands while it names only glosses the entry still carries.
function isCached(pick: readonly string[] | undefined, item: Item): boolean {
  return pick !== undefined && pick.length > 0 && pick.every((gloss) => item.glosses.includes(gloss));
}

function loadItems(): Item[] {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(path.join(APP_DIR, "public", DICTIONARY_DIR, "manifest.json"), "utf8")),
  );
  const payload = JSON.parse(
    readFileSync(path.join(APP_DIR, "public", manifest.asset.path), "utf8"),
  ) as DictionaryPayload;
  const items = payload.entries
    .filter(([, , , glosses]) => glosses.length >= 2)
    .map(([headword, pos, , glosses]) => ({ key: pickKey(headword, pos, glosses), headword, pos, glosses: [...glosses] }));
  const weight = (item: Item) => (/\s/.test(item.headword) ? -1 : item.glosses.length);
  return items.sort((a, b) => weight(b) - weight(a));
}

const INSTRUCTIONS =
  "You order the Spanish translations of English dictionary entries. For each entry choose the translation a fluent " +
  `bilingual speaker would give first for that English word in that part of speech, then the next ${PICKS_PER_ENTRY - 1} ` +
  "most useful and distinct meanings. Prefer the everyday, general sense over a technical, dated or regional one, and a " +
  "base form (infinitive for verbs, singular for nouns) over an inflected one. Copy every translation exactly as listed. " +
  'Reply with JSON only: {"picks": {"<id>": ["first", "second", "third"]}} with one key per entry id.';

async function ask(batch: Item[]): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set: pass --env-file with the app's key");
  const entries = batch.map((item, index) => ({ id: String(index), word: item.headword, pos: item.pos, translations: item.glosses }));
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      max_completion_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: JSON.stringify(entries) },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`model answered ${response.status}`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { picks?: Record<string, unknown> };
  return parsed.picks ?? {};
}

// Only glosses the entry carries, once each; an answer with none of them says nothing.
function accept(item: Item, answer: unknown): string[] | null {
  if (!Array.isArray(answer)) return null;
  const chosen = [...new Set(answer.filter((gloss): gloss is string => typeof gloss === "string" && item.glosses.includes(gloss)))];
  return chosen.length === 0 ? null : chosen.slice(0, PICKS_PER_ENTRY);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const picks = readPicks();
  const todo = loadItems()
    .filter((item) => !isCached(picks[item.key], item))
    .slice(0, limit);
  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH));
  console.log(`[pick] ${todo.length} entries in ${batches.length} batches, model ${MODEL}`);
  if (args.includes("--dry")) return;

  let next = 0;
  let done = 0;
  let missed = 0;
  async function worker(): Promise<void> {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const answers = await ask(batch);
        batch.forEach((item, index) => {
          const chosen = accept(item, answers[String(index)]);
          if (chosen === null) missed++;
          else picks[item.key] = chosen;
        });
      } catch (error) {
        missed += batch.length;
        console.error(`[pick] batch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      done++;
      writePicks(picks);
      if (done % 20 === 0) console.log(`[pick] ${done}/${batches.length} batches, ${missed} entries left unanswered`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  console.log(`[pick] done: ${Object.keys(picks).length} picks held, ${missed} unanswered (rerun to retry)`);
}

void main();
