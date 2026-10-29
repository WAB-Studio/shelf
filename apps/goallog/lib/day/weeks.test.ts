import assert from "node:assert/strict";
import test from "node:test";

import { civilDateToDate } from "@/lib/zone";

import { goalWeekProgress } from "@/components/week/week-progress";

import { dayBefore, horizonForWeeks, horizonWeeksOf, weekIndexOf, weekSpan } from "./weeks";

// One goal opened on each weekday that matters: its first Sunday and the
// Monday after it differ in every case.
const CASES = [
  { name: "Monday", openedOn: "2026-09-28", firstSunday: "2026-10-04", nextMonday: "2026-10-05" },
  { name: "Wednesday", openedOn: "2026-09-30", firstSunday: "2026-10-04", nextMonday: "2026-10-05" },
  { name: "Sunday", openedOn: "2026-10-04", firstSunday: "2026-10-04", nextMonday: "2026-10-05" },
];

function plusDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

for (const { name, openedOn, firstSunday, nextMonday } of CASES) {
  test(`weekIndexOf: a goal opened on a ${name} ends week 1 on the first Sunday and opens week 2 the next Monday`, () => {
    assert.equal(weekIndexOf(openedOn, openedOn), 1);
    assert.equal(weekIndexOf(openedOn, firstSunday), 1);
    assert.equal(weekIndexOf(openedOn, nextMonday), 2);
    assert.equal(weekIndexOf(openedOn, plusDays(nextMonday, 7)), 3);
  });

  test(`weekSpan: week 1 of a goal opened on a ${name} runs from the opening day to the first Sunday`, () => {
    assert.deepEqual(weekSpan(openedOn, 1, 1), { startsOn: openedOn, endsOn: firstSunday });
    assert.deepEqual(weekSpan(openedOn, 2, 2), { startsOn: nextMonday, endsOn: plusDays(nextMonday, 6) });
    assert.deepEqual(weekSpan(openedOn, 1, 2), { startsOn: openedOn, endsOn: plusDays(nextMonday, 6) });
  });

  test(`horizon: a goal opened on a ${name} reads 12 weeks back from horizonForWeeks and counts the partial week after opening + 84 days`, () => {
    assert.equal(horizonWeeksOf(openedOn, horizonForWeeks(openedOn, 12)), 12);
    assert.equal(horizonWeeksOf(openedOn, plusDays(openedOn, 84)), name === "Monday" ? 12 : 13);
    // The horizon is the first day after the goal: a Monday, after week 12's Sunday.
    assert.equal(plusDays(horizonForWeeks(openedOn, 12), -1), weekSpan(openedOn, 12, 12).endsOn);
  });

  test(`goalWeekProgress: the week holding the opening day of a goal opened on a ${name} reads week 1`, () => {
    const createdAt = `${openedOn}T15:00:00Z`;
    const horizon = horizonForWeeks(openedOn, 12);
    assert.deepEqual(goalWeekProgress({ horizon, createdAt }, weekSpan(openedOn, 1, 1).startsOn), {
      week: 1,
      total: 12,
    });
    assert.deepEqual(goalWeekProgress({ horizon, createdAt }, nextMonday), { week: 2, total: 12 });
  });
}

test("horizonWeeksOf: a horizon on or before the opening reads 0, never negative", () => {
  assert.equal(horizonWeeksOf("2026-09-30", "2026-09-30"), 0);
  assert.equal(horizonWeeksOf("2026-09-30", "2026-08-01"), 0);
});

test("horizonWeeksOf: a goal opened on a Tuesday ending on a Friday has 34 + 1 weeks, or 35 + 1 a week later; N weeks from horizonForWeeks still read N", () => {
  const openedOn = "2026-10-06";
  assert.equal(horizonWeeksOf(openedOn, "2027-06-04"), 35);
  assert.equal(horizonWeeksOf(openedOn, "2027-06-11"), 36);
  assert.equal(horizonWeeksOf(openedOn, horizonForWeeks(openedOn, 12)), 12);
});

test("weekSpan: with a horizon the last week ends on the goal's last day, not its Sunday", () => {
  const openedOn = "2026-10-06";
  const horizon = "2027-06-11"; // a Friday: week 36 is partial
  assert.equal(weekSpan(openedOn, 36, 36, horizon).endsOn, "2027-06-10");
  assert.equal(weekSpan(openedOn, 35, 35, horizon).endsOn, weekSpan(openedOn, 35, 35).endsOn);
  assert.equal(weekSpan(openedOn, 36, 36).endsOn, "2027-06-13");
  // A week past the goal keeps its Sunday, so it stays past the horizon.
  assert.equal(weekSpan(openedOn, 37, 37, horizon).endsOn, "2027-06-20");
});

// The horizon is the first day after the goal; a week opening on it holds no
// day of the goal and keeps its own Sunday.
test("weekSpan: a horizon falling on a Monday closes the week before it on its Sunday, and a week opening on it keeps its Sunday", () => {
  const openedOn = "2026-09-28"; // a Monday
  const horizon = "2026-10-12"; // the Monday two weeks on
  assert.deepEqual(weekSpan(openedOn, 2, 2, horizon), { startsOn: "2026-10-05", endsOn: "2026-10-11" });
  assert.deepEqual(weekSpan(openedOn, 3, 3, horizon), { startsOn: "2026-10-12", endsOn: "2026-10-18" });
});

test("weekSpan: a horizon falling mid-week closes that week on the goal's last day", () => {
  assert.deepEqual(weekSpan("2026-09-28", 2, 2, "2026-10-08"), { startsOn: "2026-10-05", endsOn: "2026-10-07" });
});

// The horizon sheet judges a typed week count by re-reading the stored horizon through these two functions. A horizon that is
// still ahead must read back at or after itself: the Monday after the week of its last day is never earlier than the horizon.
test("horizonForWeeks(today, weekIndexOf(today, dayBefore(h))) never lands before h, for every today and every open horizon", () => {
  let checked = 0;
  for (let t = 0; t <= 91; t++) {
    const today = plusDays("2026-10-12", t);
    for (let ahead = 1; ahead <= 400; ahead++) {
      const horizon = plusDays(today, ahead);
      const readBack = horizonForWeeks(today, weekIndexOf(today, dayBefore(horizon)));
      assert.ok(readBack >= horizon, `today ${today}, horizon ${horizon}: read back ${readBack}`);
      checked++;
    }
  }
  assert.equal(checked, 92 * 400);
});
