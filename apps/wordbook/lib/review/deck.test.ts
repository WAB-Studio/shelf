// RL-68's daily queue over a hand-built record: what is due, what is new, and the cap on new words.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StudyRow } from "@/lib/log/summary";

import { buildQueue, isReviewable, NEW_PER_DAY } from "./deck";
import { localDay, rate } from "./schedule";

const NOW = new Date(2026, 9, 30, 9, 0).getTime();
const DAY = 86_400_000;

function row(key: string, overrides: Partial<StudyRow> = {}): StudyRow {
  return {
    key,
    normalised: key,
    forms: [{ text: key, count: 1 }],
    display: key,
    count: 1,
    lastAt: NOW - DAY,
    lastTranslation: `${key} (es)`,
    lastDefinition: null,
    lastOutcome: "exact",
    pending: false,
    ...overrides,
  };
}

test("RL-79: a translated phrase enters the review; a miss, an untranslated one and a pending word never do", () => {
  assert.equal(isReviewable(row("snuff")), true);
  assert.equal(isReviewable(row("give it up", { lastOutcome: "translated" })), true);
  assert.equal(isReviewable(row("give it up", { lastOutcome: "untranslated", lastTranslation: null })), false);
  assert.equal(isReviewable(row("zzz", { lastOutcome: "miss", lastTranslation: null })), false);
  assert.equal(isReviewable(row("frisk", { pending: true })), false);
  assert.equal(isReviewable(row("gloam", { lastOutcome: "unlisted", lastTranslation: null, lastDefinition: "dusk" })), true);
});

test("RL-68: due words come first, earliest first; then new ones, the most looked up first", () => {
  const early = { ...rate("frisk", null, "good", NOW - 3 * DAY), due: NOW - 2 * DAY };
  const late = { ...rate("snuff", null, "good", NOW - 3 * DAY), due: NOW - DAY };
  const future = { ...rate("swish", null, "good", NOW - 3 * DAY), due: NOW + DAY };
  const queue = buildQueue(
    [row("snuff"), row("frisk"), row("swish"), row("lull", { count: 2 }), row("gust", { count: 5 })],
    [late, early, future],
    NOW,
  );
  assert.deepEqual(
    queue.items.map((item) => item.row.key),
    ["frisk", "snuff", "gust", "lull"],
  );
  assert.equal(queue.later, 1);
});

test("RL-68: new words stop at the day's cap, counting the ones already introduced today", () => {
  const rows = Array.from({ length: NEW_PER_DAY + 10 }, (_, i) => row(`w${i}`));
  assert.equal(buildQueue(rows, [], NOW).items.length, NEW_PER_DAY);
  const introduced = Array.from({ length: 5 }, (_, i) => ({
    ...rate(`w${i}`, null, "good", NOW - 60_000),
    due: NOW + DAY,
    introducedOn: localDay(NOW),
  }));
  assert.equal(buildQueue(rows, introduced, NOW).items.length, NEW_PER_DAY - 5);
});

test("RL-68: a card whose word left the record is not asked", () => {
  const orphan = { ...rate("gone", null, "good", NOW - DAY), due: NOW - 1 };
  assert.deepEqual(buildQueue([row("snuff")], [orphan], NOW).items.map((item) => item.row.key), ["snuff"]);
});

test("RL-68: a card introduced today whose word left the record does not spend today's cap", () => {
  const rows = Array.from({ length: NEW_PER_DAY + 5 }, (_, i) => row(`w${i}`));
  const orphans = Array.from({ length: 5 }, (_, i) => ({
    ...rate(`gone${i}`, null, "good", NOW - 60_000),
    introducedOn: localDay(NOW),
  }));
  assert.equal(buildQueue(rows, orphans, NOW).items.length, NEW_PER_DAY);
});
