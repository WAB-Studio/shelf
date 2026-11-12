// RL-68's calendar, on fixed moments: what one answer does to a word's next time.
import assert from "node:assert/strict";
import { test } from "node:test";

import { dueWhen, intervals, intervalUnit, isLearning, LEARN_AHEAD_MS, localDay, ON_DEMAND_REQUEUE_MS, rate, staysInSession } from "./schedule";

const NOW = new Date(2026, 9, 30, 9, 0).getTime();
const DAY = 86_400_000;

test("RL-68: a new word answered «Bien» comes back the same day; «Fácil» puts it away for days", () => {
  const good = rate("snuff", null, "good", NOW);
  const easy = rate("snuff", null, "easy", NOW);
  assert.equal(good.reps, 1);
  assert.ok(good.due > NOW && good.due < NOW + DAY);
  assert.ok(easy.due >= NOW + DAY);
  assert.equal(good.introducedOn, localDay(NOW));
});

test("RL-68: the four answers order their intervals «Otra vez» < «Difícil» < «Bien» < «Fácil»", () => {
  const learnt = rate("snuff", rate("snuff", null, "good", NOW), "good", NOW + 10 * 60_000);
  const later = learnt.due;
  const span = intervals(learnt, later);
  assert.ok(span.again < span.hard && span.hard < span.good && span.good < span.easy, JSON.stringify(span));
});

test("RL-68: a word forgotten after it was learnt counts a lapse and returns soon; its first day stays", () => {
  let card = rate("snuff", null, "easy", NOW);
  card = rate("snuff", card, "good", card.due);
  const forgotten = rate("snuff", card, "again", card.due);
  assert.equal(forgotten.lapses, 1);
  assert.ok(forgotten.due - card.due < DAY);
  assert.equal(forgotten.introducedOn, localDay(NOW));
});

test("RL-68: the card reads back from plain numbers exactly as written", () => {
  const card = rate("snuff", null, "good", NOW);
  const copy = JSON.parse(JSON.stringify(card));
  assert.deepEqual(rate("snuff", copy, "good", card.due), rate("snuff", card, "good", card.due));
});

test("RL-68: an interval reads in minutes, then hours, then days", () => {
  assert.deepEqual(intervalUnit(30_000), { unit: "minutes", count: 1 });
  assert.deepEqual(intervalUnit(10 * 60_000), { unit: "minutes", count: 10 });
  assert.deepEqual(intervalUnit(3 * 3_600_000), { unit: "hours", count: 3 });
  assert.deepEqual(intervalUnit(4 * DAY), { unit: "days", count: 4 });
});

test("RL-91: a learning step due within 20 minutes stays in the session; a day's interval does not", () => {
  const first = rate("snuff", null, "again", NOW);
  assert.equal(first.due - NOW, 60_000);
  assert.equal(staysInSession(first, NOW), true);
  // «Difícil» and «Bien» on a new entry are the 6 and 10 minute steps: both within the learn-ahead.
  assert.equal(staysInSession(rate("snuff", null, "hard", NOW), NOW), true);
  assert.equal(staysInSession(rate("snuff", null, "good", NOW), NOW), true);
  assert.equal(staysInSession(rate("snuff", null, "easy", NOW), NOW), false);
  assert.equal(LEARN_AHEAD_MS, 20 * 60_000);
});

test("RL-91: the learn-ahead is a span: a step due just over it stays out", () => {
  const card = rate("snuff", null, "good", NOW);
  assert.equal(staysInSession({ ...card, due: NOW + LEARN_AHEAD_MS }, NOW), true);
  assert.equal(staysInSession({ ...card, due: NOW + LEARN_AHEAD_MS + 1 }, NOW), false);
});

test("RL-91: a word asked for alone brings back only a short «Otra vez»", () => {
  assert.equal(staysInSession(rate("snuff", null, "again", NOW), NOW, ON_DEMAND_REQUEUE_MS), true);
  assert.equal(staysInSession(rate("snuff", null, "good", NOW), NOW, ON_DEMAND_REQUEUE_MS), false);
});

test("RL-91: a card on a learning or relearning step is learning; a new, reviewed or easy one is not", () => {
  assert.equal(isLearning(rate("snuff", null, "good", NOW)), true);
  assert.equal(isLearning(rate("snuff", null, "easy", NOW)), false);
  const reviewed = rate("snuff", null, "easy", NOW);
  assert.equal(isLearning(rate("snuff", reviewed, "again", reviewed.due)), true);
});

test("a due moment is named by the reader's own day: today, tomorrow, or a date", () => {
  assert.equal(dueWhen(NOW + 3_600_000, NOW), "today");
  assert.equal(dueWhen(NOW + DAY, NOW), "tomorrow");
  assert.equal(dueWhen(NOW + 3 * DAY, NOW), "later");
});
