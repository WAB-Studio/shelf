import assert from "node:assert/strict";
import test from "node:test";

import { habitWeeks, mondaysTouching, weekMonthOf, weeksOfMonth } from "./habit-weeks";

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

import { habitThisWeek } from "./habit-weeks";

test("w2: a Thursday that closes the month keeps its week in that month", () => {
  assert.equal(weekMonthOf("2025-07-28"), "2025-07-01");
  assert.deepEqual(weeksOfMonth("2025-07-01"), ["2025-06-30", "2025-07-07", "2025-07-14", "2025-07-21", "2025-07-28"]);
  assert.equal(weekMonthOf("2026-12-28"), "2026-12-01");
  assert.deepEqual(weeksOfMonth("2026-12-01"), ["2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"]);
});

const yoga = {
  count: 2,
  createdOn: "2026-08-17",
  retiredOn: "2026-10-07" as string | null,
  today: "2026-10-13",
  daysDoneByWeek: new Map([
    ["2026-08-17", 2], ["2026-08-24", 2], ["2026-08-31", 2], ["2026-09-07", 2], ["2026-09-14", 2],
    ["2026-09-28", 2], ["2026-10-05", 2],
  ]),
};

test("E5: the week of retirement met before retiring counts and is met", () => {
  assert.deepEqual(habitWeeks({ ...yoga, month: "2026-08-01" }), { met: 2, counted: 2 });
  assert.deepEqual(habitWeeks({ ...yoga, month: "2026-09-01" }), { met: 3, counted: 4 });
  assert.deepEqual(habitWeeks({ ...yoga, month: "2026-10-01" }), { met: 2, counted: 2 });
});

test("E5: retired Wednesday with only the 5th done, the unmet week does not count", () => {
  const input = { ...yoga, daysDoneByWeek: new Map([["2026-09-28", 2], ["2026-10-05", 1]]) };
  assert.deepEqual(habitWeeks({ ...input, month: "2026-10-01" }), { met: 1, counted: 1 });
});

test("E5: retired Thursday 8 Oct with only the 5th done, the unmet week lived its Thursday and counts", () => {
  const input = { ...yoga, retiredOn: "2026-10-08", daysDoneByWeek: new Map([["2026-09-28", 2], ["2026-10-05", 1]]) };
  assert.deepEqual(habitWeeks({ ...input, month: "2026-10-01" }), { met: 1, counted: 2 });
});

test("E5b: retired today, the week in progress counts once met", () => {
  const input = {
    count: 1,
    createdOn: "2026-09-07",
    retiredOn: "2026-10-13",
    today: "2026-10-13",
    daysDoneByWeek: new Map([["2026-09-07", 1], ["2026-09-14", 1], ["2026-09-21", 1], ["2026-09-28", 1], ["2026-10-05", 1], ["2026-10-12", 1]]),
  };
  assert.deepEqual(habitWeeks({ ...input, month: "2026-10-01" }), { met: 3, counted: 3 });
});

test("E5c: the retirement week whose Thursday is next month counts in the month of retirement", () => {
  const input = {
    count: 1,
    createdOn: "2026-09-07",
    retiredOn: "2026-09-29",
    today: "2026-10-13",
    daysDoneByWeek: new Map([["2026-09-07", 1], ["2026-09-14", 1], ["2026-09-21", 1], ["2026-09-28", 1]]),
  };
  assert.deepEqual(habitWeeks({ ...input, month: "2026-09-01" }), { met: 4, counted: 4 });
  assert.deepEqual(habitWeeks({ ...input, month: "2026-10-01" }), { met: 0, counted: 0 });
  const without = { ...input, daysDoneByWeek: new Map([["2026-09-07", 1], ["2026-09-14", 1], ["2026-09-21", 1]]) };
  assert.deepEqual(habitWeeks({ ...without, month: "2026-09-01" }), { met: 3, counted: 3 });
});

test("a week is met at exactly count days and over, not below", () => {
  const input = { ...base, count: 2, month: "2026-10-01", today: "2026-10-19" };
  assert.equal(habitWeeks({ ...input, daysDoneByWeek: new Map([["2026-10-05", 3]]) }).met, 1);
  assert.equal(habitWeeks({ ...input, daysDoneByWeek: new Map([["2026-10-05", 2]]) }).met, 1);
  assert.equal(habitWeeks({ ...input, daysDoneByWeek: new Map([["2026-10-05", 1]]) }).met, 0);
});

test("habitThisWeek: done of the Monday of today, zero when none, null once retired", () => {
  const args = { count: 1, retiredOn: null, today: "2026-10-13", daysDoneByWeek: new Map([["2026-10-12", 1]]) };
  assert.deepEqual(habitThisWeek(args), { done: 1, count: 1 });
  assert.deepEqual(habitThisWeek({ ...args, daysDoneByWeek: new Map() }), { done: 0, count: 1 });
  assert.deepEqual(habitThisWeek({ ...args, count: 2 }), { done: 1, count: 2 });
  assert.equal(habitThisWeek({ ...args, retiredOn: "2026-10-07" }), null);
  assert.deepEqual(habitThisWeek({ ...args, today: "2026-10-18", daysDoneByWeek: new Map([["2026-10-12", 2], ["2026-10-19", 5]]) }), { done: 2, count: 1 });
});

test("an unmet retirement week stays in its Thursday's month, not the month of retirement", () => {
  const input = {
    count: 2,
    createdOn: "2026-06-01",
    retiredOn: "2026-08-01",
    today: "2026-10-13",
    daysDoneByWeek: new Map([["2026-07-27", 1]]),
  };
  assert.equal(habitWeeks({ ...input, month: "2026-07-01" }).counted, 5);
  assert.equal(habitWeeks({ ...input, month: "2026-08-01" }).counted, 0);
  const met = { ...input, daysDoneByWeek: new Map([["2026-07-27", 2]]) };
  assert.deepEqual(habitWeeks({ ...met, month: "2026-08-01" }), { met: 1, counted: 1 });
  assert.equal(habitWeeks({ ...met, month: "2026-07-01" }).counted, 4);
});

test("mondaysTouching: every week a month touches, from the one holding the 1st (RP-145)", () => {
  // October 2026 starts on a Thursday and ends on a Saturday.
  assert.deepEqual(mondaysTouching("2026-10-01"), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  // August 2026 starts on a Saturday: its first week is July's by Thursday, and still touches it.
  assert.equal(mondaysTouching("2026-08-01")[0], "2026-07-27");
  assert.equal(weeksOfMonth("2026-08-01")[0], "2026-08-03");
  // February 2027 starts on a Monday and ends on a Sunday: four weeks, none outside it.
  assert.deepEqual(mondaysTouching("2027-02-01"), ["2027-02-01", "2027-02-08", "2027-02-15", "2027-02-22"]);
});
