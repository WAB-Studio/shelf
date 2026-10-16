import assert from "node:assert/strict";
import { test } from "node:test";

import { periodDoneOn } from "./period";
import type { DeclaredFact } from "./types";

const fact = (commitmentId: string, day: string): DeclaredFact =>
  ({ commitmentId, day, quantity: null, unit: null }) as DeclaredFact;

test("periodDoneOn: a weekly cadence counts distinct days of the week up to the day, today's included", () => {
  const facts = [fact("a", "2026-09-14"), fact("a", "2026-09-14"), fact("a", "2026-09-16"), fact("a", "2026-09-13")];
  assert.equal(periodDoneOn({ kind: "times_per_week", count: 3 }, "a", facts, "2026-09-16"), 2);
});

test("periodDoneOn: a monthly cadence reaches back over earlier weeks of its month, not into another month", () => {
  const facts = [fact("a", "2026-09-03"), fact("a", "2026-08-31"), fact("b", "2026-09-04")];
  assert.equal(periodDoneOn({ kind: "times_per_month", count: 4 }, "a", facts, "2026-09-20"), 1);
});

test("periodDoneOn: a fact after the day drawn is not counted", () => {
  assert.equal(periodDoneOn({ kind: "times_per_month", count: 4 }, "a", [fact("a", "2026-09-21")], "2026-09-20"), 0);
});

test("periodDoneOn: a cadence counted by the day has no period", () => {
  assert.equal(periodDoneOn({ kind: "daily" }, "a", [], "2026-09-20"), null);
});
