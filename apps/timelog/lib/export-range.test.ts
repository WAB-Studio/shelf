import assert from "node:assert/strict";
import { test } from "node:test";

import { exportRange } from "./export-range";

test("a range is two real days, from on or before to, up to 366 days (RT-15)", () => {
  assert.ok(exportRange.safeParse({ from: "2026-10-30", to: "2026-10-30" }).success);
  assert.ok(exportRange.safeParse({ from: "2026-01-01", to: "2027-01-01" }).success);
  assert.equal(exportRange.safeParse({ from: "2026-01-01", to: "2027-01-02" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-10-30", to: "2026-10-29" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success, false);
  assert.equal(exportRange.safeParse({ from: "2026-10-30" }).success, false);
});
