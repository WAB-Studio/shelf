import assert from "node:assert/strict";
import test from "node:test";

import { horizonForWeeks } from "@/lib/day/weeks";

import { defaultPhaseWeeks, horizonWeeks, phaseSpanKeeping, weekIndex, weeksToPhaseSpan } from "./phase-weeks";

// A phase imported in dates may start midweek or end on a Monday. Opening it and saving
// without touching a week must hand back its own dates, not the week's Monday and Sunday.
test("phaseSpanKeeping: a week left as it was keeps the phase's own date", () => {
  const kept = { startsOn: "2026-12-01", endsOn: "2027-02-28" };
  assert.deepEqual(phaseSpanKeeping("2026-10-15", 8, 20, null, kept), kept);
});

test("phaseSpanKeeping: an edge the person moved snaps to its week, the other keeps its date", () => {
  const kept = { startsOn: "2026-12-01", endsOn: "2027-02-28" };
  assert.deepEqual(phaseSpanKeeping("2026-10-15", 9, 20, null, kept), { startsOn: "2026-12-07", endsOn: "2027-02-28" });
  assert.deepEqual(phaseSpanKeeping("2026-10-15", 8, 19, null, kept), { startsOn: "2026-12-01", endsOn: "2027-02-21" });
});

test("phaseSpanKeeping: with nothing to keep it is the week span", () => {
  assert.deepEqual(phaseSpanKeeping("2026-10-15", 2, 3, null), weeksToPhaseSpan("2026-10-15", 2, 3, null));
});

// RP-15: week 1 opens exactly on the goal's own opening day; later weeks on a Monday.
test("weeksToPhaseSpan: week 1 starts on the goal's own opening day", () => {
  const span = weeksToPhaseSpan("2026-01-15", 1, 4);
  assert.equal(span.startsOn, "2026-01-15");
});

// 2026-01-15 is a Thursday: week 4 ends on Sunday 2026-02-08, across a month boundary.
test("weeksToPhaseSpan: a span's end is a Sunday and crosses a month boundary", () => {
  const span = weeksToPhaseSpan("2026-01-15", 1, 4);
  assert.equal(span.endsOn, "2026-02-08");
});

// A later span starts the day after the previous one's own end — no gap,
// no shared day, the way a prefilled second phase must sit against a first.
test("weeksToPhaseSpan: a phase starting the week after another has no shared day", () => {
  const first = weeksToPhaseSpan("2026-01-15", 1, 4);
  const second = weeksToPhaseSpan("2026-01-15", 5, 8);
  assert.equal(second.startsOn, "2026-02-09");
  assert.notEqual(second.startsOn, first.endsOn);
});

// Round-trip through `weekIndex`, at both ends of the same week: the first
// and the last day of week N must both read back as week N.
test("weeksToPhaseSpan and weekIndex agree at both ends of a span", () => {
  const openedOn = "2026-01-15";
  const span = weeksToPhaseSpan(openedOn, 3, 3);
  assert.equal(weekIndex(openedOn, span.startsOn), 3);
  assert.equal(weekIndex(openedOn, span.endsOn), 3);
});

// A horizon set in exact weeks (`NewGoalForm`) reads back as that same whole
// number, never a fraction.
test("horizonWeeks reads back the exact number of weeks a horizon was set in", () => {
  const openedOn = "2026-01-15";
  const horizon = horizonForWeeks(openedOn, 12);
  assert.equal(horizonWeeks(openedOn, horizon), 12);
});

// RP-15: the page's default span passes the form's own checks.
test("defaultPhaseWeeks: the partial last week is offered and ends on the goal's last day", () => {
  const openedOn = "2026-01-15";
  const horizon = "2026-02-20"; // a Friday: week 6 is partial
  const last = weeksToPhaseSpan(openedOn, 1, 5);
  assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases: [last] }), { from: 6, to: 6 });
  assert.equal(weeksToPhaseSpan(openedOn, 6, 6, horizon).endsOn, "2026-02-19");
});

test("defaultPhaseWeeks: a goal opened Tue 2026-10-06 ending Fri 2027-06-11 offers 35-36 after week 34, ending 2027-06-10", () => {
  const openedOn = "2026-10-06";
  const horizon = "2027-06-11";
  assert.equal(horizonWeeks(openedOn, horizon), 36);
  const phases = [weeksToPhaseSpan(openedOn, 1, 34)];
  assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases }), { from: 35, to: 36 });
  assert.equal(weeksToPhaseSpan(openedOn, 35, 36, horizon).endsOn, "2027-06-10");
});

test("defaultPhaseWeeks: no week is left once the last phase reaches the goal's last day", () => {
  const openedOn = "2026-01-15";
  const horizon = "2026-02-20";
  const phases = [weeksToPhaseSpan(openedOn, 1, 6, horizon)];
  assert.equal(defaultPhaseWeeks({ openedOn, horizon, phases }), null);
});

test("defaultPhaseWeeks: weeks 1-4 taken, 35 full weeks yields 5-8", () => {
  const openedOn = "2026-01-15";
  const horizon = "2026-09-24"; // openedOn + 36 * 7 days: 36 weeks and a partial one
  const phases = [weeksToPhaseSpan(openedOn, 1, 4)];
  assert.equal(horizonWeeks(openedOn, horizon), 37);
  assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases }), { from: 5, to: 8 });
});

test("defaultPhaseWeeks: 6 full weeks left yields a 4-week span, never past the horizon, the partial week counted", () => {
  const openedOn = "2026-01-15";
  const horizon = "2026-04-09"; // 12 weeks
  const phases = [weeksToPhaseSpan(openedOn, 1, 6)];
  assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases }), { from: 7, to: 10 });
  const tight = [weeksToPhaseSpan(openedOn, 1, 10)];
  assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases: tight }), { from: 11, to: 13 });
});

test("defaultPhaseWeeks: no phase opens on week 1", () => {
  assert.deepEqual(
    defaultPhaseWeeks({ openedOn: "2026-01-15", horizon: "2026-04-09", phases: [] }),
    { from: 1, to: 4 },
  );
});

test("defaultPhaseWeeks: starts after the latest phase, whatever order the phases come in", () => {
  const openedOn = "2026-01-15";
  const horizon = "2026-09-24";
  const early = weeksToPhaseSpan(openedOn, 1, 4);
  const late = weeksToPhaseSpan(openedOn, 9, 12);
  const middle = weeksToPhaseSpan(openedOn, 5, 8);
  for (const phases of [[early, middle, late], [late, early, middle], [middle, late, early]]) {
    assert.deepEqual(defaultPhaseWeeks({ openedOn, horizon, phases }), { from: 13, to: 16 });
  }
});
