import assert from "node:assert/strict";
import test from "node:test";

import { asksOn } from "./cadence";
import type { CommitmentPlan, DeclaredFact } from "./types";

function plan(overrides: Partial<CommitmentPlan> = {}): CommitmentPlan {
  return {
    id: "c1",
    cadence: { kind: "daily" },
    satisfiedBy: { kind: "tap" },
    retiredAt: null,
    createdOn: "2000-01-01",
    ...overrides,
  };
}

function fact(day: string, overrides: Partial<DeclaredFact> = {}): DeclaredFact {
  return {
    commitmentId: "c1",
    day,
    writtenAt: `${day}T12:00:00Z`,
    quantity: null,
    unit: null,
    note: null,
    ...overrides,
  };
}

// --- daily ---

test("daily: asks every day, with no facts at all", () => {
  const p = plan({ cadence: { kind: "daily" } });
  assert.equal(asksOn(p, "2026-03-01", []), true);
  assert.equal(asksOn(p, "2026-03-02", []), true);
});

test("daily: a retired commitment asks nothing from the day after it was retired", () => {
  // 2026-03-03 is a Tuesday.
  const p = plan({ cadence: { kind: "daily" }, retiredAt: "2026-03-03" });
  assert.equal(asksOn(p, "2026-03-02", []), true, "Monday before still asks");
  assert.equal(asksOn(p, "2026-03-04", []), false, "no day after it asks");
});

// --- weekdays ---

// 2026-03-02 is a Monday; the week runs to Sunday 2026-03-08.
const weekMondayToSunday = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-07",
  "2026-03-08",
];

test("weekdays: asks only on the named weekday (ISO: 1 = Monday .. 7 = Sunday)", () => {
  const p = plan({ cadence: { kind: "weekdays", days: [1] } });
  assert.equal(asksOn(p, "2026-03-02", []), true, "Monday");
  assert.equal(asksOn(p, "2026-03-03", []), false, "Tuesday");
});

test("weekdays: a commitment for Sunday (7) asks on Sunday and on no other day", () => {
  // The old, non-ISO encoding read Sunday as 0, which this cadence never
  // holds — a plan with `days: [7]` would have asked on no day at all.
  const p = plan({ cadence: { kind: "weekdays", days: [7] } });
  const asked = weekMondayToSunday.filter((day) => asksOn(p, day, []));
  assert.deepEqual(asked, ["2026-03-08"], "only the Sunday of the week");
});

test("weekdays: a commitment for Monday (1) asks on Monday and on no other day", () => {
  const p = plan({ cadence: { kind: "weekdays", days: [1] } });
  const asked = weekMondayToSunday.filter((day) => asksOn(p, day, []));
  assert.deepEqual(asked, ["2026-03-02"], "only the Monday of the week");
});

test("weekdays: an empty day list never asks", () => {
  const p = plan({ cadence: { kind: "weekdays", days: [] } });
  assert.equal(asksOn(p, "2026-03-02", []), false);
});

// --- times_per_week ---

test("times_per_week: asks while the week's quota is not yet met", () => {
  const p = plan({ cadence: { kind: "times_per_week", count: 2 } });
  // Monday 2026-03-02 .. Sunday 2026-03-08.
  const facts = [fact("2026-03-02")];
  assert.equal(asksOn(p, "2026-03-04", facts), true, "one done, one still owed");
});

test("times_per_week: stops asking once the week's quota is met, before the day itself", () => {
  const p = plan({ cadence: { kind: "times_per_week", count: 2 } });
  const facts = [fact("2026-03-02"), fact("2026-03-03")];
  assert.equal(asksOn(p, "2026-03-05", facts), false, "quota already met earlier in the week");
});

test("times_per_week: the day that would complete the quota still asks", () => {
  const p = plan({ cadence: { kind: "times_per_week", count: 2 } });
  const facts = [fact("2026-03-02")];
  assert.equal(asksOn(p, "2026-03-03", facts), true, "still owed as of the start of the day");
});

test("times_per_week: a new week resets the quota", () => {
  const p = plan({ cadence: { kind: "times_per_week", count: 2 } });
  const facts = [fact("2026-03-02"), fact("2026-03-03")];
  assert.equal(asksOn(p, "2026-03-09", facts), true, "next Monday owes the quota again");
});

// --- every_n_days ---

test("every_n_days: asks only on the anchor and every n-th day after it", () => {
  const p = plan({ cadence: { kind: "every_n_days", n: 3, anchor: "2026-03-01" } });
  assert.equal(asksOn(p, "2026-03-01", []), true, "the anchor day itself");
  assert.equal(asksOn(p, "2026-03-04", []), true, "3 days later");
  assert.equal(asksOn(p, "2026-03-03", []), false, "2 days later");
});

test("every_n_days: never asks before the anchor", () => {
  const p = plan({ cadence: { kind: "every_n_days", n: 3, anchor: "2026-03-01" } });
  assert.equal(asksOn(p, "2026-02-28", []), false);
});

// --- times_per_month ---

test("times_per_month: asks while the month's quota is not yet met", () => {
  const p = plan({ cadence: { kind: "times_per_month", count: 1 } });
  assert.equal(asksOn(p, "2026-03-15", []), true);
});

test("times_per_month: stops asking once the month's quota is met, before the day itself", () => {
  const p = plan({ cadence: { kind: "times_per_month", count: 1 } });
  const facts = [fact("2026-03-05")];
  assert.equal(asksOn(p, "2026-03-15", facts), false);
});

test("times_per_month: a new month resets the quota", () => {
  const p = plan({ cadence: { kind: "times_per_month", count: 1 } });
  const facts = [fact("2026-03-05")];
  assert.equal(asksOn(p, "2026-04-01", facts), true);
});

// --- retirement holds across every cadence, not only "daily" ---

test("a week already lived keeps its shape: each day is judged against its own date, not today's", () => {
  const p = plan({
    cadence: { kind: "weekdays", days: [1, 2, 3, 4, 5] },
    retiredAt: "2026-03-10",
  });
  assert.equal(asksOn(p, "2026-03-09", []), true, "Monday, before retirement");
  assert.equal(asksOn(p, "2026-03-11", []), false, "Wednesday, after retirement");
});

// --- an evening retirement is still the retirement's own civil day, not UTC's ---

test("retired at 23:30 Bogotá on a Wednesday still asks that Wednesday and stops asking Thursday", () => {
  // 2026-03-04 is a Wednesday (`weekMondayToSunday` above); 23:30 in
  // `America/Bogota` (UTC-5) on that day is 04:30 UTC the *next* day —
  // exactly the shape `to_jsonb` hands back for a `timestamptz` column, and
  // exactly the instant a bare `day > plan.retiredAt` string compare reads
  // as "not yet retired" all the way through Thursday, the defect
  // `lib/queries/day.ts`'s own SQL filter carried before its own fix.
  const p = plan({ cadence: { kind: "daily" }, retiredAt: "2026-03-05T04:30:00Z" });
  assert.equal(asksOn(p, "2026-03-04", []), true, "Wednesday, the day it was retired");
  assert.equal(asksOn(p, "2026-03-05", []), false, "Thursday, the very next civil day");
});

// --- a commitment asks nothing before the day it was written ---

test("a plan created on D asks nothing on D-1 and asks on D", () => {
  const p = plan({ cadence: { kind: "daily" }, createdOn: "2026-09-28" });
  assert.equal(asksOn(p, "2026-09-27", []), false, "the day before it existed");
  assert.equal(asksOn(p, "2026-09-28", []), true, "its own day");
});

test("createdOn refuses the day before under every cadence, not only daily", () => {
  const cadences: CommitmentPlan["cadence"][] = [
    { kind: "weekdays", days: [1, 2, 3, 4, 5, 6, 7] },
    { kind: "times_per_week", count: 3 },
    { kind: "times_per_month", count: 3 },
    { kind: "every_n_days", n: 1, anchor: "2026-09-01" },
  ];
  for (const cadence of cadences) {
    const p = plan({ cadence, createdOn: "2026-09-28" });
    assert.equal(asksOn(p, "2026-09-27", []), false, cadence.kind);
  }
});
