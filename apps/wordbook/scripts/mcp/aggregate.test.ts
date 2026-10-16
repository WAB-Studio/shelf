// The three read-only queries the MCP server answers, over a small export
// written here. RL-27: nothing in them modifies the log.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LookupRecord } from "../../lib/log/types";
import { recentWords, topWords, wordHistory } from "./aggregate";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function row(normalised: string, at: number, overrides: Partial<LookupRecord> = {}): LookupRecord {
  return {
    schema: 2,
    at,
    text: normalised,
    normalised,
    kind: "word",
    outcome: "exact",
    headword: normalised,
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: null,
    ...overrides,
  };
}

const EXPORT: readonly LookupRecord[] = Object.freeze([
  row("frisk", NOW - 5 * DAY),
  row("snuff", NOW - 4 * DAY),
  row("snuff", NOW - 3 * DAY, { outcome: "miss", headword: null }),
  row("snuff", NOW - 1 * DAY),
  row("swish", NOW - 2 * DAY),
  row("swish", NOW - 6 * DAY),
  row("Frisk", NOW - 9 * DAY),
]);

test("topWords orders by frequency and breaks a tie by the latest lookup", () => {
  const top = topWords(EXPORT, { limit: 10, now: NOW });
  assert.deepEqual(
    top.map((w) => [w.normalised, w.count]),
    [
      ["snuff", 3],
      ["swish", 2],
      ["frisk", 1],
      ["Frisk", 1],
    ],
  );
  // The tie between frisk (5 days ago) and Frisk (9 days ago) goes to the later one.
  assert.equal(top[0].missRate, 1 / 3);
});

test("topWords honours the limit and the window", () => {
  assert.equal(topWords(EXPORT, { limit: 1, now: NOW }).length, 1);
  const windowed = topWords(EXPORT, { limit: 10, sinceDays: 4.5, now: NOW });
  assert.deepEqual(
    windowed.map((w) => [w.normalised, w.count]),
    [
      ["snuff", 3],
      ["swish", 1],
    ],
  );
});

test("recentWords orders by the latest lookup, newest first", () => {
  const recent = recentWords(EXPORT, { limit: 10 });
  assert.deepEqual(
    recent.map((w) => w.normalised),
    ["snuff", "swish", "frisk", "Frisk"],
  );
  assert.equal(recentWords(EXPORT, { limit: 2 }).length, 2);
});

test("wordHistory returns every lookup of a word, oldest first, ignoring case", () => {
  const history = wordHistory(EXPORT, "  FRISK ");
  assert.deepEqual(
    history.map((r) => r.at),
    [NOW - 9 * DAY, NOW - 5 * DAY],
  );
  assert.deepEqual(wordHistory(EXPORT, "absent"), []);
});

test("the queries leave the export untouched", () => {
  const before = JSON.stringify(EXPORT);
  topWords(EXPORT, { limit: 10, now: NOW });
  recentWords(EXPORT, { limit: 10 });
  wordHistory(EXPORT, "snuff");
  assert.equal(JSON.stringify(EXPORT), before);
});

test("missRate counts misses only: inflected and untranslated rows are not misses", () => {
  const rows = [
    row("run", NOW - 4 * DAY, { outcome: "inflected", headword: "run" }),
    row("run", NOW - 3 * DAY, { outcome: "untranslated", headword: null }),
    row("run", NOW - 2 * DAY, { outcome: "miss", headword: null }),
    row("run", NOW - 1 * DAY),
  ];
  const [word] = topWords(rows, { limit: 1, now: NOW });
  assert.equal(word.count, 4);
  assert.equal(word.missRate, 1 / 4);
});

test("a row exactly sinceDays old stays inside the window", () => {
  const rows = [row("edge", NOW - 7 * DAY), row("old", NOW - 7 * DAY - 1)];
  const top = topWords(rows, { limit: 10, sinceDays: 7, now: NOW });
  assert.deepEqual(
    top.map((w) => w.normalised),
    ["edge"],
  );
});

// The plan leaves a same-instant tie unspecified; this pins the built
// behaviour: the row met last wins.
test("two headwords at the same instant: the later row in the log is reported", () => {
  const rows = [
    row("saw", NOW - DAY, { headword: "see", outcome: "inflected" }),
    row("saw", NOW - DAY, { headword: "saw", outcome: "inflected" }),
  ];
  assert.equal(topWords(rows, { limit: 1, now: NOW })[0].headword, "saw");
});
