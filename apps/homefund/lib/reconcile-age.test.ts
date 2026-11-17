import assert from "node:assert/strict";
import { test } from "node:test";

import { daysBetween, isStale, reconcileAge, STALE_AFTER_DAYS } from "./reconcile-age";

test("days between two civil dates are whole, across a month and a leap day", () => {
  assert.equal(daysBetween("2026-11-17", "2026-11-17"), 0);
  assert.equal(daysBetween("2026-10-18", "2026-11-17"), 30);
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2);
});

test("an account counts its days from its latest reconciliation, or from when it was added", () => {
  const counted = { latestReconciledOn: "2026-11-05", addedOn: "2026-01-01" };
  const never = { latestReconciledOn: null, addedOn: "2026-10-01" };

  assert.deepEqual(reconcileAge(counted, "2026-11-17"), { days: 12, never: false });
  assert.deepEqual(reconcileAge(never, "2026-11-17"), { days: 47, never: true });
});

test("only an account past thirty days is stale", () => {
  const on = (day: string) => ({ latestReconciledOn: day, addedOn: "2026-01-01" });

  assert.equal(isStale(on("2026-10-18"), "2026-11-17"), false);
  assert.equal(STALE_AFTER_DAYS, 30);
  assert.equal(isStale(on("2026-10-17"), "2026-11-17"), true);
  assert.equal(isStale({ latestReconciledOn: null, addedOn: "2026-11-10" }, "2026-11-17"), false);
});
