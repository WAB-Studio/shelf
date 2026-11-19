import assert from "node:assert/strict";
import { test } from "node:test";

import { appsOfWeek, askedWeek, clampWeek, daysOfWeek, mondayOf, weekMinutes, weekSteps } from "./week";

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

test("the week's seven figures add up to the total shown, whatever the seconds", () => {
  // Floored one by one, 59 s of each of seven days is 0 min; summed first it would be 6 min.
  const odd = [3599, 3599, 3599, 3599, 3599, 3599, 3599];
  const { minutes, total } = weekMinutes(odd);
  assert.deepEqual(minutes, [59, 59, 59, 59, 59, 59, 59]);
  assert.equal(minutes.reduce((sum, one) => sum + one, 0), total);
  assert.equal(total, 413);
  assert.deepEqual(weekMinutes([59, 0, 0, 0, 0, 0, 0]), { minutes: [0, 0, 0, 0, 0, 0, 0], total: 0 });
  // 9 h 52 min and its neighbours: 32 h 41 min is 1961 min.
  assert.equal(weekMinutes([9 * 3600 + 52 * 60 + 40, 9 * 3600 + 1, 8 * 3600 + 59 * 60 + 59, 5 * 3600 + 49 * 60, 0, 0, 0]).total, 592 + 540 + 539 + 349);
});

test("the week's apps group under readable names with a figure per day", () => {
  const days = daysOfWeek("2026-11-16");
  const rows = [
    { day: "2026-11-16", app: "chrome.exe", seconds: 100 },
    { day: "2026-11-17", app: "Chrome", seconds: 50 },
    { day: "2026-11-17", app: "Code.exe", seconds: 400 },
    { day: "2026-11-18", app: "LockApp.exe", seconds: 20 },
    { day: "2026-12-01", app: "Code.exe", seconds: 999 },
  ];
  assert.deepEqual(appsOfWeek(rows, days, "Sistema"), [
    { app: "VS Code", total: 400, perDay: [0, 400, 0, 0, 0, 0, 0] },
    { app: "Chrome", total: 150, perDay: [100, 50, 0, 0, 0, 0, 0] },
    { app: "Sistema", total: 20, perDay: [0, 0, 20, 0, 0, 0, 0] },
  ]);
});
