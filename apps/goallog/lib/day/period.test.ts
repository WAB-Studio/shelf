import assert from "node:assert/strict";
import { test } from "node:test";

import { periodDoneOn } from "./period";
import type { Cadence, DeclaredFact } from "./types";

const fact = (commitmentId: string, day: string, extra: Partial<DeclaredFact> = {}): DeclaredFact =>
  ({ commitmentId, day, quantity: null, unit: null, ...extra }) as DeclaredFact;
const tap = (id: string, cadence: Cadence) => ({ id, cadence, satisfiedBy: { kind: "tap" as const } });

test("periodDoneOn: a weekly cadence counts distinct days of the week up to the day, today's included", () => {
  const facts = [fact("a", "2026-09-14"), fact("a", "2026-09-14"), fact("a", "2026-09-16"), fact("a", "2026-09-13")];
  assert.equal(periodDoneOn(tap("a", { kind: "times_per_week", count: 3 }), facts, "2026-09-16"), 2);
});

test("periodDoneOn: a monthly cadence reaches back over earlier weeks of its month, not into another month", () => {
  const facts = [fact("a", "2026-09-03"), fact("a", "2026-08-31"), fact("b", "2026-09-04")];
  assert.equal(periodDoneOn(tap("a", { kind: "times_per_month", count: 4 }), facts, "2026-09-20"), 1);
});

test("periodDoneOn: a fact after the day drawn is not counted", () => {
  assert.equal(periodDoneOn(tap("a", { kind: "times_per_month", count: 4 }), [fact("a", "2026-09-21")], "2026-09-20"), 0);
});

test("periodDoneOn: a cadence counted by the day has no period", () => {
  assert.equal(periodDoneOn(tap("a", { kind: "daily" }), [], "2026-09-20"), null);
});

test("RP-148: a quantity day short of its target is not one of the week's times; lowered to what it did, it is", () => {
  const plan = { id: "run", cadence: { kind: "times_per_week", count: 4 } as Cadence, satisfiedBy: { kind: "quantity" as const, target: 5, unit: "km" } };
  const facts = [
    fact("run", "2026-09-14", { quantity: 5 }),
    fact("run", "2026-09-15", { quantity: 3 }),
    fact("run", "2026-09-16", { quantity: 4, dayTarget: 4 }),
  ];
  assert.equal(periodDoneOn(plan, facts, "2026-09-16"), 2);
});
