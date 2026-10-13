import assert from "node:assert/strict";
import test from "node:test";

import { measureByWeek } from "./review";
import { tallyDay, tallyDays } from "./tally";
import { horizonWeeksOf, weekSpan } from "./weeks";
import type { DayView } from "./types";
import { defaultPhaseWeeks, horizonWeeks, MAX_GOAL_WEEKS } from "@/components/goal/phase-weeks";
import { endedLastDay, goalWeekProgress } from "@/components/week/week-progress";

function view(day: string, slots: string[]): DayView {
  return {
    day,
    phase: null,
    slots: slots.map((commitmentId) => ({ commitmentId, satisfied: commitmentId === "c1", satisfiedBy: null, labelKey: null, quantity: null, partial: false })),
  };
}

test("tallyDay: a loose habit counts the day it has a slot", () => {
  const t = tallyDay({ view: view("2026-10-13", ["c1", "c2"]), goals: [], commitments: [{ id: "c1", goalId: null }, { id: "c2", goalId: "g-gone" }] });
  assert.equal(t.total, 1);
  assert.equal(t.done, 1);
});

test("tallyDays: loose habits and goals with no end count", () => {
  const days = ["2026-10-12", "2026-10-13"].map((d) => view(d, ["c1", "c2"]));
  const tally = tallyDays({
    view: { start: "2026-10-12", days },
    goals: [{ id: "g1", horizon: null, createdAt: "2026-10-13T15:00:00Z" }],
    commitments: [{ id: "c1", goalId: null }, { id: "c2", goalId: "g1" }],
  });
  assert.deepEqual(tally.map((t) => t.total), [1, 2]);
});

test("horizonWeeksOf and horizonWeeks: no end has no weeks", () => {
  assert.equal(horizonWeeksOf("2026-10-01", null), null);
  assert.equal(horizonWeeks("2026-10-01", null), null);
  assert.equal(horizonWeeks("2026-10-01", "2026-11-01"), horizonWeeksOf("2026-10-01", "2026-11-01"));
});

test("weekSpan: no end keeps the Sunday", () => {
  assert.equal(weekSpan("2026-10-01", 2, 2, null).endsOn, "2026-10-11");
});

test("measureByWeek: with no end the current week is current and the list stops there", () => {
  const weeks = measureByWeek({ openedOn: "2026-09-29", horizon: null, today: "2026-10-13", unit: null, facts: [], evidence: [], phases: [] });
  assert.equal(weeks.length, 3);
  assert.equal(weeks[2].current, true);
});

test("goalWeekProgress and endedLastDay: no end draws neither", () => {
  assert.equal(goalWeekProgress({ horizon: null, createdAt: "2026-10-01T12:00:00Z" }, "2026-10-12"), null);
  assert.equal(endedLastDay(null, "2026-10-13"), null);
});

test("defaultPhaseWeeks: no end caps at 520 weeks from the opening", () => {
  assert.equal(MAX_GOAL_WEEKS, 520);
  assert.deepEqual(defaultPhaseWeeks({ openedOn: "2026-10-01", horizon: null, phases: [] }), { from: 1, to: 4 });
  const phases = [{ startsOn: "2026-10-01", endsOn: weekSpan("2026-10-01", 520, 520).endsOn }];
  assert.equal(defaultPhaseWeeks({ openedOn: "2026-10-01", horizon: null, phases }), null);
});
