import assert from "node:assert/strict";
import { test } from "node:test";

import { monthLeft } from "./month-left";

test("the remainder spreads over the days left, today included, floored", () => {
  // 30 days in November; on the 10th there are 21 left.
  assert.deepEqual(monthLeft(30_000, 500_000, "2026-11-10"), { remainingCents: 470_000, daysLeft: 21, perDayCents: 22_380 });
  assert.deepEqual(monthLeft(0, 1_000_000, "2026-11-01"), { remainingCents: 1_000_000, daysLeft: 30, perDayCents: 33_333 });
});

test("on the last day of the month the whole remainder is the day's, leap February included", () => {
  assert.deepEqual(monthLeft(100_000, 500_000, "2026-11-30"), { remainingCents: 400_000, daysLeft: 1, perDayCents: 400_000 });
  assert.equal(monthLeft(0, 100, "2028-02-29").daysLeft, 1);
  assert.equal(monthLeft(0, 100, "2028-02-01").daysLeft, 29);
  assert.equal(monthLeft(0, 100, "2026-12-31").daysLeft, 1);
});

test("past the budget the remainder is negative and the day's share is zero, never below", () => {
  assert.deepEqual(monthLeft(650_000, 500_000, "2026-11-10"), { remainingCents: -150_000, daysLeft: 21, perDayCents: 0 });
});

test("with no budget nothing is left to spend per day, and the remainder reads minus the spend", () => {
  assert.deepEqual(monthLeft(30_000, 0, "2026-11-10"), { remainingCents: -30_000, daysLeft: 21, perDayCents: 0 });
});
