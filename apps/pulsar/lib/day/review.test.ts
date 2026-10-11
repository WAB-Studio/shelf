import assert from "node:assert/strict";
import test from "node:test";

import { measureByWeek } from "./review";
import type { DeclaredFact, EvidenceDay, Phase } from "./types";

function fact(day: string, quantity: number, unit: string): DeclaredFact {
  return { commitmentId: "goal-commitment", day, writtenAt: `${day}T12:00:00Z`, quantity, unit, note: null };
}

function evidenceDay(day: string, quantity: number, unit: string): EvidenceDay {
  return { day, quantity, unit, labelKey: "sources.readingLookups" };
}

// 2026-09-29 is a Tuesday: week 1 opens that day and closes on its Sunday
// (RP-17); week 2 opens the Monday after.
const OPENED_ON_TUESDAY = "2026-09-29";
const FAR_HORIZON = "2027-01-01";

test("measureByWeek: a goal opened on a Tuesday buckets facts by its own week, not the calendar week", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: "2026-10-05",
    unit: "min",
    facts: [
      fact("2026-09-29", 10, "min"), // day 1 of week 1
      fact("2026-10-04", 15, "min"), // the first Sunday, week 1's own last day
      fact("2026-10-05", 20, "min"), // the next Monday, the first day of week 2
    ],
    evidence: [],
    phases: [],
  });

  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].index, 1);
  assert.equal(weeks[0].startsOn, "2026-09-29");
  assert.equal(weeks[0].endsOn, "2026-10-04");
  assert.equal(weeks[0].total, 25);
  assert.equal(weeks[1].index, 2);
  assert.equal(weeks[1].startsOn, "2026-10-05");
  assert.equal(weeks[1].total, 20);
});

test("measureByWeek: a fact in another unit adds nothing to the measure's own total", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: OPENED_ON_TUESDAY,
    unit: "min",
    facts: [fact("2026-09-29", 40, "searches")],
    evidence: [],
    phases: [],
  });

  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].total, 0);
});

test("measureByWeek: evidence in the measure's own unit adds to the total, alongside declared facts", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: OPENED_ON_TUESDAY,
    unit: "searches",
    facts: [fact("2026-09-29", 5, "searches")],
    evidence: [evidenceDay("2026-09-30", 3, "searches"), evidenceDay("2026-10-01", 2, "min")],
    phases: [],
  });

  assert.equal(weeks.length, 1);
  // 5 declared + 3 evidence in "searches"; the "min" evidence row is skipped.
  assert.equal(weeks[0].total, 8);
});

test("measureByWeek: a null unit gives every week a total of 0, facts and evidence notwithstanding", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: OPENED_ON_TUESDAY,
    unit: null,
    facts: [fact("2026-09-29", 999, "min")],
    evidence: [evidenceDay("2026-09-29", 999, "min")],
    phases: [],
  });

  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].total, 0);
});

test("measureByWeek: a goal opened three weeks ago with no facts returns three rows, each reading 0 — a gap is drawn, never absent", () => {
  const weeks = measureByWeek({
    openedOn: "2026-09-15", // a Tuesday two Mondays before "today" below: week 3
    horizon: FAR_HORIZON,
    today: "2026-09-28",
    unit: "min",
    facts: [],
    evidence: [],
    phases: [],
  });

  assert.equal(weeks.length, 3);
  assert.deepEqual(
    weeks.map((week) => week.total),
    [0, 0, 0],
  );
  assert.deepEqual(
    weeks.map((week) => week.index),
    [1, 2, 3],
  );
});

test("measureByWeek: a today past the horizon stops at the horizon's own week, never past it", () => {
  const weeks = measureByWeek({
    openedOn: "2026-01-06",
    horizon: "2026-02-02", // the Monday after week 4
    today: "2026-06-01", // long past the horizon
    unit: "min",
    facts: [],
    evidence: [],
    phases: [],
  });

  assert.equal(weeks.length, 4);
  assert.equal(weeks[weeks.length - 1].index, 4);
});

test("measureByWeek: phaseName reads phaseOn(phases, startsOn)'s own name, null with no phase covering the week's start", () => {
  const phases: Phase[] = [
    { id: "p1", name: "cimientos", startsOn: "2026-09-29", endsOn: "2026-10-04" },
  ];
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: "2026-10-05",
    unit: "min",
    facts: [],
    evidence: [],
    phases,
  });

  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].phaseName, "cimientos");
  assert.equal(weeks[1].phaseName, null);
});

test("measureByWeek: current is true only for the row holding today, false for every other row", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: "2026-10-05", // the first day of week 2
    unit: "min",
    facts: [],
    evidence: [],
    phases: [],
  });

  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].current, false);
  assert.equal(weeks[1].current, true);
});

test("measureByWeek: evidence on a week's last day counts in that week, not the next", () => {
  const weeks = measureByWeek({
    openedOn: OPENED_ON_TUESDAY,
    horizon: FAR_HORIZON,
    today: "2026-10-05",
    unit: "searches",
    facts: [],
    evidence: [
      evidenceDay("2026-10-04", 7, "searches"), // week 1's own last day, a Sunday
      evidenceDay("2026-10-05", 4, "searches"), // week 2's first day, a Monday
    ],
    phases: [],
  });

  assert.deepEqual(
    weeks.map((week) => week.total),
    [7, 4],
  );
});

// RP-17: a finished goal has no current week, and its last week closes on
// the goal's last day. `horizon` is the first day after the goal.
const ENDED = {
  openedOn: "2026-09-16", // Wednesday
  horizon: "2026-10-08", // last day Wednesday 2026-10-07
  unit: "min",
  evidence: [],
  phases: [],
};

test("measureByWeek: the last week of an ended goal closes on the goal's last day", () => {
  const weeks = measureByWeek({ ...ENDED, today: "2026-10-11", facts: [] });
  assert.equal(weeks[weeks.length - 1].endsOn, "2026-10-07");
});

test("measureByWeek: no week is current once the goal has ended", () => {
  const weeks = measureByWeek({ ...ENDED, today: "2026-10-11", facts: [] });
  assert.equal(weeks[weeks.length - 1].current, false);
  assert.equal(weeks.some((week) => week.current), false);
});

test("measureByWeek: the goal's last day still reads as the current week", () => {
  const weeks = measureByWeek({ ...ENDED, today: "2026-10-07", facts: [] });
  const last = weeks[weeks.length - 1];
  assert.equal(last.current, true);
  assert.equal(last.endsOn, "2026-10-07");
});

test("measureByWeek: an earlier week of an ended goal keeps its Sunday", () => {
  const weeks = measureByWeek({ ...ENDED, today: "2026-10-11", facts: [] });
  assert.equal(weeks[0].endsOn, "2026-09-20");
  assert.equal(weeks[1].endsOn, "2026-09-27");
});

test("measureByWeek: a fact after the goal's last day adds nothing to the last week", () => {
  const weeks = measureByWeek({
    ...ENDED,
    today: "2026-10-11",
    facts: [fact("2026-10-07", 4, "min"), fact("2026-10-09", 30, "min")],
  });
  assert.equal(weeks[weeks.length - 1].total, 4);
});
