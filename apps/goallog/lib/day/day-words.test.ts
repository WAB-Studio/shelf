import assert from "node:assert/strict";
import test from "node:test";

import { dayWords } from "./day-words";
import { weekOf } from "@/lib/zone";

const TODAY = "2026-09-30"; // Wednesday; week 2026-09-28 .. 2026-10-04

test("no day of today's week names a month, Monday and Sunday included", () => {
  for (const day of weekOf(TODAY)) {
    assert.equal(dayWords(day, TODAY).month, null, day);
  }
});

test("weekday counts from Monday and day is the day of month", () => {
  assert.deepEqual(dayWords("2026-09-28", TODAY), { weekday: 0, day: 28, month: null });
  assert.deepEqual(dayWords("2026-10-04", TODAY), { weekday: 6, day: 4, month: null });
});

test("the Sunday before and the Monday after name their month", () => {
  assert.deepEqual(dayWords("2026-09-27", TODAY), { weekday: 6, day: 27, month: 8 });
  assert.deepEqual(dayWords("2026-10-05", TODAY), { weekday: 0, day: 5, month: 9 });
});

test("across a month end the in-week days after the boundary stay null", () => {
  assert.equal(dayWords("2026-10-01", TODAY).month, null);
});

test("across a year end", () => {
  const today = "2026-12-31"; // Thursday; week 12-28 .. 01-03
  assert.equal(dayWords("2027-01-03", today).month, null);
  assert.deepEqual(dayWords("2027-01-04", today), { weekday: 0, day: 4, month: 0 });
  assert.deepEqual(dayWords("2026-12-27", today), { weekday: 6, day: 27, month: 11 });
});
