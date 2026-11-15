// RL-68's daily queue over a hand-built record: what is due, what is new, and the cap on new words.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StudyRow } from "@/lib/log/summary";

import { buildQueue, buildQueueFor, isReviewable, NEW_PER_DAY, orderSession, resumeQueue } from "./deck";
import { LEARN_AHEAD_MS, localDay, rate } from "./schedule";

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

test("RL-78: a translated phrase enters the review; a miss, an untranslated one and a pending word never do", () => {
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
  assert.equal(queue.nextDue, future.due);
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

test("one entry on demand: asked now whether or not it is due, and nothing else of the day's queue", () => {
  const later = { ...rate("frisk", null, "good", NOW), due: NOW + 3 * DAY };
  const queue = buildQueueFor([row("frisk"), row("snuff")], [later], "frisk", NOW);
  assert.deepEqual(queue.items.map((item) => item.row.key), ["frisk"]);
  assert.ok(queue.items[0].card !== null && queue.items[0].card.due <= NOW);
  assert.deepEqual(buildQueueFor([row("snuff")], [], "frisk", NOW).items, []);
  assert.deepEqual(buildQueueFor([row("snuff", { pending: true })], [], "snuff", NOW).items, []);
});

test("a word reviewed on demand takes no slot of the day's new entries", () => {
  const rows = Array.from({ length: NEW_PER_DAY + 1 }, (_, i) => row(`word${i}`, { count: 100 - i }));
  const onDemand = rate("word0", null, "good", NOW, "");
  assert.equal(onDemand.introducedOn, "");
  const fresh = buildQueue(rows, [onDemand], NOW).items.filter((item) => item.card === null);
  assert.equal(fresh.length, NEW_PER_DAY);
  const counted = rate("word0", null, "good", NOW);
  assert.equal(buildQueue(rows, [counted], NOW).items.filter((item) => item.card === null).length, NEW_PER_DAY - 1);
});

test("the queue counts the new entries the day's cap held back, and none when the cap held nothing", () => {
  const rows = Array.from({ length: NEW_PER_DAY + 7 }, (_, i) => row(`w${i}`));
  assert.equal(buildQueue(rows, [], NOW).newWaiting, 7);
  assert.equal(buildQueue(rows.slice(0, 3), [], NOW).newWaiting, 0);
  assert.equal(buildQueueFor(rows, [], "w0", NOW).newWaiting, 0);
});

// A card the way the session leaves it after an answer: its own due moment, whatever FSRS said.
function learning(key: string, dueIn: number, answerAt = NOW - 60_000) {
  return { ...rate(key, null, "again", answerAt), due: NOW + dueIn };
}

test("RL-91: a learning step due within 20 minutes is in the queue, waiting for its minute", () => {
  const queue = buildQueue([row("snuff"), row("frisk")], [learning("snuff", 8 * 60_000)], NOW);
  assert.deepEqual(queue.items.map((item) => item.row.key), ["frisk", "snuff"]);
  assert.equal(queue.later, 0);
  assert.equal(queue.nextDue, null);
});

test("RL-91: a learning step past the learn-ahead, or a card on review, stays out of the queue", () => {
  const past = learning("snuff", LEARN_AHEAD_MS + 60_000);
  const reviewed = { ...rate("frisk", null, "easy", NOW - DAY), due: NOW + 10 * 60_000 };
  const queue = buildQueue([row("snuff"), row("frisk")], [past, reviewed], NOW);
  assert.deepEqual(queue.items, []);
  assert.equal(queue.later, 2);
  assert.equal(queue.nextDue, reviewed.due);
});

test("RL-91: a reload one minute after «Otra vez» still asks the entry", () => {
  const answered = rate("time", null, "again", NOW);
  const queue = buildQueue([row("time")], [answered], NOW + 5_000);
  assert.deepEqual(queue.items.map((item) => item.row.key), ["time"]);
  assert.equal(queue.later, 0);
});

test("RL-91: a learning step already due comes before a new entry; one still waiting comes after", () => {
  const due = learning("snuff", -1_000);
  const waiting = learning("frisk", 5 * 60_000);
  const queue = buildQueue([row("gust", { count: 9 }), row("snuff"), row("frisk")], [waiting, due], NOW);
  assert.deepEqual(queue.items.map((item) => item.row.key), ["snuff", "gust", "frisk"]);
});

test("RL-91: orderSession puts a step that came due ahead of the new entries and the earliest waiting first", () => {
  const items = [
    { row: row("later"), card: learning("later", 15 * 60_000) },
    { row: row("sooner"), card: learning("sooner", 2 * 60_000) },
    { row: row("fresh"), card: null },
    { row: row("ready"), card: learning("ready", -1_000) },
  ];
  assert.deepEqual(orderSession(items, NOW).map((item) => item.row.key), ["ready", "fresh", "sooner", "later"]);
  // Two minutes on, «sooner» is due too and goes ahead of the new entry.
  assert.deepEqual(orderSession(items, NOW + 3 * 60_000).map((item) => item.row.key), ["ready", "sooner", "fresh", "later"]);
});

test("RL-91: rebuilding a session counts what it answered once: later holds the others, total the whole", () => {
  const away = { ...rate("snuff", null, "easy", NOW - 60_000), due: NOW + 3 * DAY };
  const comes = learning("frisk", 3 * 60_000);
  const waiting = { ...rate("swish", null, "easy", NOW - DAY), due: NOW + 2 * DAY };
  const rows = [row("snuff"), row("frisk"), row("swish"), row("gust")];
  const { queue, total } = resumeQueue(rows, [away, comes, waiting], NOW, ["snuff", "frisk"]);
  assert.deepEqual(queue.items.map((item) => item.row.key), ["gust", "frisk"]);
  // `swish` waits; `snuff` was answered here and the finished screen adds it back itself.
  assert.equal(queue.later, 1);
  assert.equal(queue.nextDue, waiting.due);
  assert.equal(total, 3);
});

test("RL-91: an entry that came due while the tab was away is asked again on the rebuild", () => {
  const early = learning("time", 10 * 60_000);
  const before = resumeQueue([row("time")], [early], NOW, ["time"]);
  assert.deepEqual(before.queue.items.map((item) => item.row.key), ["time"]);
  const after = resumeQueue([row("time")], [early], NOW + 30 * 60_000, ["time"]);
  assert.deepEqual(after.queue.items.map((item) => item.row.key), ["time"]);
  assert.equal(after.queue.later, 0);
});
