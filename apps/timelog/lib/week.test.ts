import assert from "node:assert/strict";
import { test } from "node:test";

import { askedWeek, clampWeek, dayStrip, daysOfWeek, mondayOf, weekSteps } from "./week";

test("a week runs Monday to Sunday", () => {
  assert.equal(mondayOf("2026-10-28"), "2026-10-26");
  assert.equal(mondayOf("2026-11-01"), "2026-10-26");
  assert.equal(mondayOf("2026-10-26"), "2026-10-26");
  assert.equal(daysOfWeek("2026-10-26").at(-1), "2026-11-01");
});

test("‹ › stop at the first upload's week and at this week (RT-05)", () => {
  assert.deepEqual(weekSteps("2026-10-26", "2026-10-14", "2026-10-28"), { prev: "2026-10-19", next: null });
  assert.deepEqual(weekSteps("2026-10-12", "2026-10-14", "2026-10-28"), { prev: null, next: "2026-10-19" });
  assert.deepEqual(weekSteps("2026-10-26", null, "2026-10-28"), { prev: null, next: null });
});

test("a week asked for outside the span lands on its nearer end; a malformed one on this week", () => {
  assert.equal(clampWeek(askedWeek("2026-10-01", "2026-10-28"), "2026-10-14", "2026-10-28"), "2026-10-12");
  assert.equal(clampWeek(askedWeek("2027-01-01", "2026-10-28"), "2026-10-14", "2026-10-28"), "2026-10-26");
  assert.equal(clampWeek(askedWeek("2026-10-21", "2026-10-28"), "2026-10-14", "2026-10-28"), "2026-10-19");
  assert.equal(clampWeek(askedWeek("ayer", "2026-10-28"), "2026-10-14", "2026-10-28"), "2026-10-26");
  assert.equal(clampWeek(askedWeek("2026-02-30", "2026-10-28"), "2026-01-01", "2026-10-28"), "2026-10-26");
});

test("a first upload dated tomorrow, in next week, still lands on this week", () => {
  assert.equal(clampWeek(askedWeek("2026-10-26", "2026-11-01"), "2026-11-02", "2026-11-01"), "2026-10-26");
  assert.equal(clampWeek(askedWeek(undefined, "2026-11-01"), "2026-11-02", "2026-11-01"), "2026-10-26");
  assert.deepEqual(weekSteps("2026-10-26", "2026-11-02", "2026-11-01"), { prev: null, next: null });
});

test("the day strip names the week, the reachable days and where the arrows land", () => {
  const strip = dayStrip("2026-10-28", "2026-10-14", "2026-10-31");
  assert.equal(strip.monday, "2026-10-26");
  assert.deepEqual(strip.days.map((one) => one.reachable), [true, true, true, true, true, true, false]);
  assert.deepEqual(strip.days.map((one) => one.current), [false, false, true, false, false, false, false]);
  assert.equal(strip.prev, "2026-10-21");
  assert.equal(strip.next, null);
});

test("an arrow of the day strip stays inside the first upload and today", () => {
  assert.equal(dayStrip("2026-10-21", "2026-10-19", "2026-10-31").prev, null);
  assert.equal(dayStrip("2026-10-21", "2026-10-14", "2026-10-31").prev, "2026-10-14");
  assert.equal(dayStrip("2026-10-28", "2026-10-14", "2026-11-04").next, "2026-11-04");
  assert.equal(dayStrip("2026-10-23", "2026-10-14", "2026-10-31").next, "2026-10-30");
});
