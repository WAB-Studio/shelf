import assert from "node:assert/strict";
import { test } from "node:test";

import { exportRange, rangeRetry, typedDay } from "./export-range";

test("a range is two real days, from on or before to, up to 366 days (RT-15)", () => {
  assert.ok(exportRange.safeParse({ from: "2026-10-30", to: "2026-10-30" }).success);
  assert.ok(exportRange.safeParse({ from: "2026-01-01", to: "2027-01-01" }).success);
  assert.equal(exportRange.safeParse({ from: "2026-01-01", to: "2027-01-02" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-10-30", to: "2026-10-29" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-10-30" }).success, false);
});

test("a refused range goes back to the form with the real days that were typed", () => {
  assert.equal(rangeRetry("2026-10-31", "2026-10-01"), "/exportar?error=range&from=2026-10-31&to=2026-10-01");
  assert.equal(rangeRetry("nope", null), "/exportar?error=range");
  assert.equal(typedDay("2026-10-31", "2026-10-02"), "2026-10-31");
  assert.equal(typedDay("2026-02-30", "2026-10-02"), "2026-10-02");
  assert.equal(typedDay(undefined, "2026-10-02"), "2026-10-02");
});
