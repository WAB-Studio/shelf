import assert from "node:assert/strict";
import test from "node:test";

import { parseWeekParam, weekSteps } from "./week-param";

const TODAY = "2026-10-07"; // Wednesday; its Monday is 2026-10-05

test("a Wednesday three weeks back is a past week named by its Monday", () => {
  assert.deepEqual(parseWeekParam("2026-09-16", TODAY), { kind: "past", monday: "2026-09-14" });
});

test("any weekday of a past week reads as its Monday, Sunday included", () => {
  assert.deepEqual(parseWeekParam("2026-10-04", TODAY), { kind: "past", monday: "2026-09-28" });
  assert.deepEqual(parseWeekParam("2026-09-28", TODAY), { kind: "past", monday: "2026-09-28" });
});

test("absent, today and any day of this week read as this week", () => {
  assert.deepEqual(parseWeekParam(undefined, TODAY), { kind: "this" });
  assert.deepEqual(parseWeekParam(TODAY, TODAY), { kind: "this" });
  assert.deepEqual(parseWeekParam("2026-10-05", TODAY), { kind: "this" });
  assert.deepEqual(parseWeekParam("2026-10-11", TODAY), { kind: "this" });
});

test("with no limit given next week, a far future, a false date, a non-date and an array redirect", () => {
  for (const raw of ["2026-10-12", "2030-01-01", "2026-02-30", "abc", "", ["a", "b"], ["2026-09-14"]]) {
    assert.deepEqual(parseWeekParam(raw, TODAY), { kind: "redirect" }, JSON.stringify(raw));
  }
});

test("the week crosses a year boundary", () => {
  assert.deepEqual(parseWeekParam("2026-01-01", "2026-01-14"), { kind: "past", monday: "2025-12-29" });
});

test("the first week has no prev and a middle one steps a Monday each way", () => {
  const base = { thisMonday: "2026-10-05", firstMonday: "2026-09-14" };
  assert.deepEqual(weekSteps({ ...base, monday: "2026-09-14" }), { prev: null, next: "2026-09-21" });
  assert.deepEqual(weekSteps({ ...base, monday: "2026-09-21" }), { prev: "2026-09-14", next: "2026-09-28" });
});

test("this week has no next and steps back to the Monday before", () => {
  assert.deepEqual(
    weekSteps({ monday: "2026-10-05", thisMonday: "2026-10-05", firstMonday: "2026-09-14" }),
    { prev: "2026-09-28", next: null },
  );
});

test("a person with no goal has no prev", () => {
  assert.deepEqual(
    weekSteps({ monday: "2026-09-28", thisMonday: "2026-10-05", firstMonday: null }),
    { prev: null, next: "2026-10-05" },
  );
});

test("next Monday, any day of it, and the last Monday are coming weeks", () => {
  const last = "2026-10-26";
  assert.deepEqual(parseWeekParam("2026-10-12", TODAY, last), { kind: "coming", monday: "2026-10-12" });
  assert.deepEqual(parseWeekParam("2026-10-18", TODAY, last), { kind: "coming", monday: "2026-10-12" });
  assert.deepEqual(parseWeekParam("2026-10-26", TODAY, last), { kind: "coming", monday: "2026-10-26" });
});

test("the Monday after the last Monday redirects, and a past week still reads as today", () => {
  assert.deepEqual(parseWeekParam("2026-11-02", TODAY, "2026-10-26"), { kind: "redirect" });
  assert.deepEqual(parseWeekParam("2026-09-16", TODAY, "2026-10-26"), { kind: "past", monday: "2026-09-14" });
  assert.deepEqual(parseWeekParam(undefined, TODAY, "2026-10-26"), { kind: "this" });
});

test("this week's next is next Monday and the last Monday's next is null", () => {
  const base = { thisMonday: "2026-10-05", firstMonday: "2026-09-14", lastMonday: "2026-10-19" };
  assert.deepEqual(weekSteps({ ...base, monday: "2026-10-05" }), { prev: "2026-09-28", next: "2026-10-12" });
  assert.deepEqual(weekSteps({ ...base, monday: "2026-10-12" }), { prev: "2026-10-05", next: "2026-10-19" });
  assert.deepEqual(weekSteps({ ...base, monday: "2026-10-19" }), { prev: "2026-10-12", next: null });
});
