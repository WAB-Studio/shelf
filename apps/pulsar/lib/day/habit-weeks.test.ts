import assert from "node:assert/strict";
import test from "node:test";

import { habitWeeks, weekMonthOf, weeksOfMonth } from "./habit-weeks";

test("the Thursday decides the month of a week", () => {
  assert.equal(weekMonthOf("2025-09-29"), "2025-10-01");
  assert.equal(weekMonthOf("2026-09-28"), "2026-10-01");
  assert.equal(weekMonthOf("2025-10-27"), "2025-10-01");
});

test("a month has 4 or 5 weeks, by their Thursday", () => {
  assert.deepEqual(weeksOfMonth("2026-10-01"), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(weeksOfMonth("2026-08-01"), ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]);
});

const base = {
  count: 1,
  createdOn: "2026-07-08",
  retiredOn: null as string | null,
  daysDoneByWeek: new Map<string, number>(),
  month: "2026-07-01",
  today: "2026-10-13",
};

test("E3 July: created Wed 8 Jul counts 4 weeks, the one of 29 Jun not", () => {
  const done = new Map([["2026-07-06", 1], ["2026-07-13", 1], ["2026-07-20", 1]]);
  assert.deepEqual(habitWeeks({ ...base, daysDoneByWeek: done }), { met: 3, counted: 4 });
});

test("E3 October: today 13 Oct counts the weeks of 28 Sep and 5 Oct", () => {
  const done = new Map([["2026-10-05", 1]]);
  assert.deepEqual(habitWeeks({ ...base, month: "2026-10-01", daysDoneByWeek: done }), { met: 1, counted: 2 });
});

test("E4: the 30 Sep counts in the week of 29 Sep, which is October's", () => {
  const input = {
    count: 1,
    createdOn: "2025-09-15",
    retiredOn: null,
    today: "2026-10-13",
    daysDoneByWeek: new Map([["2025-09-15", 1], ["2025-09-29", 1], ["2025-10-06", 1], ["2025-10-13", 1], ["2025-10-27", 1]]),
  };
  assert.deepEqual(habitWeeks({ ...input, month: "2025-09-01" }), { met: 1, counted: 2 });
  assert.deepEqual(habitWeeks({ ...input, month: "2025-10-01" }), { met: 4, counted: 5 });
});

test("a week counts only once its Sunday is before today", () => {
  const input = { ...base, month: "2026-10-01" };
  assert.equal(habitWeeks({ ...input, today: "2026-10-18" }).counted, 2);
  assert.equal(habitWeeks({ ...input, today: "2026-10-19" }).counted, 3);
});

test("a habit created on the Friday does not count that week", () => {
  const r = habitWeeks({ ...base, createdOn: "2025-09-19", month: "2025-09-01" });
  assert.equal(r.counted, 1);
  assert.equal(habitWeeks({ ...base, createdOn: "2025-09-18", month: "2025-09-01" }).counted, 2);
});

test("the week of retirement counts when it lived its Thursday", () => {
  const input = { ...base, createdOn: "2025-09-01", month: "2025-10-01", today: "2026-10-13" };
  assert.equal(habitWeeks({ ...input, retiredOn: "2025-10-23" }).counted, 4);
  assert.equal(habitWeeks({ ...input, retiredOn: "2025-10-22" }).counted, 3);
});

test("a week is met at count days or more", () => {
  const done = new Map([["2026-10-05", 2], ["2026-10-12", 3]]);
  assert.equal(habitWeeks({ ...base, count: 3, month: "2026-10-01", today: "2026-10-19", daysDoneByWeek: done }).met, 1);
});
