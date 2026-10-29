import assert from "node:assert/strict";
import test from "node:test";

import { PAST_DAY_LIMIT } from "@/lib/validation/fact";

import { weekDayHref } from "./week-href";

const MONDAY_WEEK = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const SUNDAY_WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

test("on a Wednesday the Monday and Tuesday lead to their own screen, Wednesday and after lead nowhere", () => {
  const week = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  const today = "2026-09-30";
  assert.deepEqual(
    week.map((day) => weekDayHref(day, today)),
    ["/dia/2026-09-28", "/dia/2026-09-29", null, null, null, null, null],
  );
});

test("on a Monday no day of the week leads anywhere", () => {
  for (const day of MONDAY_WEEK) assert.equal(weekDayHref(day, "2026-09-28"), null);
});

test("on a Sunday Monday to Saturday all lead to their own screen, Sunday itself nowhere", () => {
  const hrefs = SUNDAY_WEEK.map((day) => weekDayHref(day, "2026-09-27"));
  assert.deepEqual(hrefs, [...SUNDAY_WEEK.slice(0, 6).map((day) => `/dia/${day}`), null]);
});

test("exactly PAST_DAY_LIMIT days back leads to its screen, one day further leads nowhere", () => {
  assert.equal(PAST_DAY_LIMIT, 7);
  assert.equal(weekDayHref("2026-09-23", "2026-09-30"), "/dia/2026-09-23");
  assert.equal(weekDayHref("2026-09-22", "2026-09-30"), null);
});

test("the limit crosses a month and a year", () => {
  assert.equal(weekDayHref("2025-12-25", "2026-01-01"), "/dia/2025-12-25");
  assert.equal(weekDayHref("2025-12-24", "2026-01-01"), null);
});

test("a future day leads nowhere", () => {
  assert.equal(weekDayHref("2026-10-01", "2026-09-30"), null);
});
