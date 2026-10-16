import assert from "node:assert/strict";
import test from "node:test";

import { tallyDay, tallyDays } from "./tally";
import type { DayView, WeekView } from "./types";

// 2026-09-28 is a Monday.
const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

function dayView(day: string, slots: [string, boolean][]): DayView {
  return {
    day,
    phase: null,
    slots: slots.map(([commitmentId, satisfied]) => ({
      commitmentId,
      satisfied,
      satisfiedBy: satisfied ? "declared" : null,
      labelKey: null,
      quantity: null,
      partial: false,
    })),
  };
}

function week(slotsOf: (day: string) => [string, boolean][]): WeekView {
  return { start: DAYS[0], days: DAYS.map((d) => dayView(d, slotsOf(d))) };
}

test("tallyDays: a goal ending mid-week counts the days before its horizon only", () => {
  const view = week(() => [["c1", true]]);
  const tally = tallyDays({
    view,
    goals: [{ id: "g1", horizon: "2026-10-01", createdAt: "2026-09-01T12:00:00Z" }],
    commitments: [{ id: "c1", goalId: "g1" }],
  });
  assert.deepEqual(
    tally.map((t) => t.total),
    [1, 1, 1, 0, 0, 0, 0],
  );
  assert.deepEqual(
    tally.map((t) => t.done),
    [1, 1, 1, 0, 0, 0, 0],
  );
});

test("tallyDays: a goal opening mid-week counts from its opening day", () => {
  const view = week(() => [["c1", false]]);
  const tally = tallyDays({
    view,
    goals: [{ id: "g1", horizon: "2027-01-01", createdAt: "2026-10-01T15:00:00Z" }],
    commitments: [{ id: "c1", goalId: "g1" }],
  });
  assert.deepEqual(
    tally.map((t) => t.total),
    [0, 0, 0, 1, 1, 1, 1],
  );
  assert.equal(tally[3].done, 0);
});

test("tallyDay: a day of 1 of 2 commitments reads 1 of 2, whatever one-offs were done", () => {
  const view = dayView(DAYS[0], [
    ["c1", true],
    ["c2", false],
  ]);
  const tally = tallyDay({
    view,
    goals: [{ id: "g1", openedOn: "2026-01-01", horizon: "2027-01-01" }],
    commitments: [
      { id: "c1", goalId: "g1" },
      { id: "c2", goalId: "g1" },
    ],
  });
  assert.deepEqual(tally, { day: DAYS[0], done: 1, total: 2, partial: 0 });
});

test("tallyDays: a commitment counted by the week or the month counts as a row the day asks (RP-01)", () => {
  const view = week((d) => [
    ["daily", d === DAYS[0]],
    ["weekly", d === DAYS[0]],
    ["monthly", d === DAYS[0]],
  ]);
  const goals = [{ id: "g1", horizon: "2027-01-01", createdAt: "2026-09-01T12:00:00Z" }];
  const tally = tallyDays({
    view,
    goals,
    commitments: [
      { id: "daily", goalId: "g1", cadence: { kind: "daily" } },
      { id: "weekly", goalId: "g1", cadence: { kind: "times_per_week", count: 3 } },
      { id: "monthly", goalId: "g1", cadence: { kind: "times_per_month", count: 4 } },
    ],
  });
  assert.deepEqual(tally[0], { day: DAYS[0], done: 3, total: 3, partial: 0 });
  assert.deepEqual(tally[1], { day: DAYS[1], done: 0, total: 3, partial: 0 });
});

test("tallyDays: weekday and every-n-days commitments still count by the day", () => {
  const view = week(() => [["a", true], ["b", false]]);
  const tally = tallyDays({
    view,
    goals: [{ id: "g1", horizon: "2027-01-01", createdAt: "2026-09-01T12:00:00Z" }],
    commitments: [
      { id: "a", goalId: "g1", cadence: { kind: "weekdays", days: [1, 2, 3, 4, 5, 6, 7] } },
      { id: "b", goalId: "g1", cadence: { kind: "every_n_days", n: 1, anchor: "2026-09-01" } },
    ],
  });
  assert.deepEqual(tally[2], { day: DAYS[2], done: 1, total: 2, partial: 0 });
});

test("tallyDay: equals tallyDays' cell for the same day, flexible included", () => {
  const view = week((d) => [
    ["c1", d === DAYS[1]],
    ["flex", true],
    ["c2", true],
  ]);
  const input = {
    view,
    goals: [
      { id: "g1", horizon: "2026-12-01", createdAt: "2026-09-01T12:00:00Z" },
      { id: "g2", horizon: "2026-09-30", createdAt: "2026-09-01T12:00:00Z" },
    ],
    commitments: [
      { id: "c1", goalId: "g1" },
      { id: "flex", goalId: "g1", cadence: { kind: "times_per_week" as const, count: 3 } },
      { id: "c2", goalId: "g2" },
    ],
  };
  const cells = tallyDays(input);
  for (const [i, dayView_] of view.days.entries()) {
    const single = tallyDay({
      view: dayView_,
      goals: input.goals.map((g) => ({ id: g.id, openedOn: g.createdAt.slice(0, 10), horizon: g.horizon })),
      commitments: input.commitments,
    });
    assert.deepEqual(single, cells[i]);
  }
  assert.deepEqual(cells[1], { day: DAYS[1], done: 3, total: 3, partial: 0 });
});

test("tallyDay: a partial slot counts in total and partial, never in done", () => {
  const view: DayView = {
    day: DAYS[0],
    phase: null,
    slots: [
      { commitmentId: "c1", satisfied: true, satisfiedBy: "declared", labelKey: null, quantity: 30, partial: false },
      { commitmentId: "c2", satisfied: false, satisfiedBy: null, labelKey: null, quantity: 10, partial: true },
    ],
  };
  const tally = tallyDay({
    view,
    goals: [{ id: "g1", openedOn: "2026-01-01", horizon: "2027-01-01" }],
    commitments: [
      { id: "c1", goalId: "g1" },
      { id: "c2", goalId: "g1" },
    ],
  });
  assert.deepEqual(tally, { day: DAYS[0], done: 1, total: 2, partial: 1 });
});
