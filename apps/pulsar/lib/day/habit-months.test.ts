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
  assert.equal(oct.current, true);
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
