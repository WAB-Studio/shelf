// RL-68's calendar, on fixed moments: what one answer does to a word's next time.
import assert from "node:assert/strict";
import { test } from "node:test";

import { intervals, intervalUnit, localDay, rate, staysInSession } from "./schedule";

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

test("RL-79: «Otra vez» stays in the session; «Bien» and «Fácil» on a new entry do not", () => {
  assert.equal(staysInSession(rate("snuff", null, "again", NOW), NOW), true);
  assert.equal(staysInSession(rate("snuff", null, "good", NOW), NOW), false);
  assert.equal(staysInSession(rate("snuff", null, "easy", NOW), NOW), false);
});
