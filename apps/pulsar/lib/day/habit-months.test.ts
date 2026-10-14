import assert from "node:assert/strict";
import test from "node:test";

import { askedIn, habitMonths } from "./habit-months";
import { asksOn } from "./cadence";
import type { Cadence, CommitmentPlan } from "./types";

const daily: Cadence = { kind: "daily" };

function months(overrides: Partial<Parameters<typeof habitMonths>[0]> = {}) {
  return habitMonths({
    cadence: daily,
    createdOn: "2026-08-20",
    retiredOn: null,
    daysDoneByMonth: new Map(),
    today: "2026-10-13",
    ...overrides,
  });
}

test("months run from creation to today's month, oldest first", () => {
  const result = months();
  assert.deepEqual(result.map((m) => m.month), ["2026-08-01", "2026-09-01", "2026-10-01"]);
  assert.deepEqual(result.map((m) => m.current), [false, false, true]);
});

test("a retirement closes the list at its month, with no current", () => {
  const result = months({ retiredOn: "2026-09-08" });
  assert.deepEqual(result.map((m) => m.month), ["2026-08-01", "2026-09-01"]);
  assert.equal(result.some((m) => m.current), false);
  assert.equal(result[1].asked, 8);
});

test("«de M» counts from creation", () => {
  const [oct] = months({ createdOn: "2026-10-11" });
  assert.equal(oct.asked, 3);
});

test("«de M» counts to retirement in the current month", () => {
  const [oct] = months({ createdOn: "2026-09-01", retiredOn: "2026-10-08" }).slice(-1);
  assert.equal(oct.asked, 8);
  assert.equal(oct.current, false);
});

test("a full past month counts all its days; the current one stops at today", () => {
  const result = months();
  assert.equal(result[0].asked, 12);
  assert.equal(result[1].asked, 30);
  assert.equal(result[2].asked, 13);
});

test("a week or month quota has no «de M»", () => {
  for (const cadence of [{ kind: "times_per_week", count: 3 }, { kind: "times_per_month", count: 5 }] satisfies Cadence[]) {
    assert.ok(months({ cadence }).every((m) => m.asked === null));
  }
});

test("days done are read per month", () => {
  const result = months({ daysDoneByMonth: new Map([["2026-09-01", 4]]) });
  assert.deepEqual(result.map((m) => m.daysDone), [0, 4, 0]);
});

test("askedIn matches asksOn day by day for five cadences", () => {
  const cadences: Cadence[] = [
    daily,
    { kind: "weekdays", days: [1, 3, 5] },
    { kind: "weekdays", days: [7] },
    { kind: "every_n_days", n: 3, anchor: "2026-09-29" },
    { kind: "every_n_days", n: 1, anchor: "2026-10-13" },
  ] satisfies Cadence[];
  for (const cadence of cadences) {
    const plan: CommitmentPlan = { id: "c", cadence, satisfiedBy: { kind: "tap" }, retiredAt: null, createdOn: "2026-10-03" };
    let expected = 0;
    for (let d = 1; d <= 13; d++) {
      if (asksOn(plan, `2026-10-${String(d).padStart(2, "0")}`, [])) expected += 1;
    }
    assert.equal(askedIn(plan, "2026-10-01", "2026-10-13"), expected);
    assert.equal(askedIn(plan, "2026-10-03", "2026-10-03") <= 1, true);
  }
});

test("askedIn counts both edges", () => {
  const plan: CommitmentPlan = { id: "c", cadence: daily, satisfiedBy: { kind: "tap" }, retiredAt: null, createdOn: "2000-01-01" };
  assert.equal(askedIn(plan, "2026-10-01", "2026-10-01"), 1);
  assert.equal(askedIn(plan, "2026-10-01", "2026-10-31"), 31);
});

test("weeks is set only for a times_per_week cadence", () => {
  const weekly = months({ cadence: { kind: "times_per_week", count: 1 } });
  assert.ok(weekly.every((m) => m.weeks !== null));
  assert.equal(weekly.every((m) => m.asked === null), true);
  for (const cadence of [daily, { kind: "every_n_days", n: 2, anchor: "2026-08-20" }, { kind: "times_per_month", count: 3 }] as Cadence[]) {
    assert.ok(months({ cadence }).every((m) => m.weeks === null));
  }
});

test("weeks counts the weeks of each month from daysDoneByWeek", () => {
  const result = months({
    cadence: { kind: "times_per_week", count: 1 },
    createdOn: "2026-07-08",
    daysDoneByWeek: new Map([["2026-07-06", 1], ["2026-07-13", 1], ["2026-07-20", 1]]),
  });
  assert.deepEqual(result.find((m) => m.month === "2026-07-01")?.weeks, { met: 3, counted: 4 });
  assert.deepEqual(result.find((m) => m.month === "2026-10-01")?.weeks, { met: 0, counted: 2 });
});

const weekly = (count: number): Cadence => ({ kind: "times_per_week", count });
const octOf = (result: ReturnType<typeof months>) => result.find((m) => m.month === "2026-10-01");

test("thisWeek E3: only the month of today, with the week's done and count", () => {
  const result = months({
    cadence: weekly(1),
    createdOn: "2026-07-08",
    daysDoneByWeek: new Map([["2026-10-12", 1]]),
  });
  assert.deepEqual(octOf(result)?.thisWeek, { done: 1, count: 1 });
  assert.deepEqual(result.filter((m) => m.month !== "2026-10-01").map((m) => m.thisWeek), [null, null, null]);
});

test("thisWeek with nothing done is zero, not null; E4 counts of 2", () => {
  assert.deepEqual(octOf(months({ cadence: weekly(1), createdOn: "2026-07-08" }))?.thisWeek, { done: 0, count: 1 });
  const nadar = months({ cadence: weekly(2), createdOn: "2026-10-13", daysDoneByWeek: new Map([["2026-10-12", 1]]) });
  assert.deepEqual(octOf(nadar)?.thisWeek, { done: 1, count: 2 });
});

test("thisWeek is null for a retired habit and for any other cadence", () => {
  assert.equal(octOf(months({ cadence: weekly(2), createdOn: "2026-08-17", retiredOn: "2026-10-07" }))?.thisWeek, null);
  for (const cadence of [daily, { kind: "every_n_days", n: 2, anchor: "2026-08-20" }, { kind: "times_per_month", count: 3 }] as Cadence[]) {
    assert.ok(months({ cadence }).every((m) => m.thisWeek === null));
  }
});

test("thisWeek on a Sunday reads the week that ends that day", () => {
  const result = months({
    cadence: weekly(1),
    createdOn: "2026-07-08",
    today: "2026-10-18",
    daysDoneByWeek: new Map([["2026-10-12", 2], ["2026-10-19", 9]]),
  });
  assert.equal(octOf(result)?.thisWeek?.done, 2);
});

test("current: a retired habit's last month is not current, a live one's is", () => {
  const retired = months({ cadence: weekly(2), createdOn: "2026-08-17", retiredOn: "2026-10-07" });
  assert.equal(octOf(retired)?.current, false);
  assert.equal(octOf(months({ cadence: weekly(2), createdOn: "2026-08-17" }))?.current, true);
});

test("E5 in habitMonths: October is 2 of 2 weeks", () => {
  const result = months({
    cadence: weekly(2),
    createdOn: "2026-08-17",
    retiredOn: "2026-10-07",
    daysDoneByWeek: new Map([["2026-09-28", 2], ["2026-10-05", 2]]),
  });
  assert.deepEqual(octOf(result)?.weeks, { met: 2, counted: 2 });
});

test("E6: the window of Mes: on Sun 1 Nov the week of 26 Oct is November's? no, October's, and in progress", () => {
  const result = months({
    cadence: weekly(1),
    createdOn: "2026-07-08",
    today: "2026-11-01",
    daysDoneByWeek: new Map([["2026-10-26", 1]]),
  });
  const nov = result.find((m) => m.month === "2026-11-01");
  assert.deepEqual(nov?.thisWeek, { done: 1, count: 1 });
  assert.deepEqual(nov?.weeks, { met: 0, counted: 0 });
});
