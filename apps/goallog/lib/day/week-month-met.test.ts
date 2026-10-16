import assert from "node:assert/strict";
import test from "node:test";

import { deriveWeek } from "./derive";
import type { CommitmentPlan, DeclaredFact } from "./types";

// «N al mes» asks by its month: handed the month's facts, a week after the
// quota was met asks nothing; handed only that week's facts, it asks every
// day. `loadWeek` owes `deriveWeek` the former (`scripts/plan/week-month-facts.ts`).

const monthly = (count: number): CommitmentPlan => ({
  id: "pesarse",
  cadence: { kind: "times_per_month", count },
  satisfiedBy: { kind: "tap" },
  retiredAt: null,
  createdOn: "2000-01-01",
});

const tap = (day: string): DeclaredFact => ({
  commitmentId: "pesarse",
  day,
  writtenAt: `${day}T12:00:00Z`,
  quantity: null,
  unit: null,
  note: null,
});

const askedDays = (facts: DeclaredFact[], count: number) =>
  deriveWeek({ commitments: [monthly(count)], phases: [], facts, evidence: {}, day: "2026-03-18" }).days.map(
    (d) => d.slots.length,
  );

test("deriveWeek: a month met on the 1st and 2nd asks nothing in the third week", () => {
  assert.deepEqual(askedDays([tap("2026-03-01"), tap("2026-03-02")], 2), [0, 0, 0, 0, 0, 0, 0]);
});

test("deriveWeek: a month not yet met asks every day of the week", () => {
  assert.deepEqual(askedDays([tap("2026-03-01"), tap("2026-03-02")], 3), [1, 1, 1, 1, 1, 1, 1]);
});

test("deriveWeek: facts of another month do not count against this one", () => {
  assert.deepEqual(askedDays([tap("2026-02-26"), tap("2026-02-27")], 2), [1, 1, 1, 1, 1, 1, 1]);
});

test("deriveWeek: the week's own facts alone leave a met month asking (why the feed must start at the 1st)", () => {
  assert.deepEqual(askedDays([], 2), [1, 1, 1, 1, 1, 1, 1]);
});
