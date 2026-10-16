import assert from "node:assert/strict";
import test from "node:test";

import { endedLastDay, goalWeekProgress } from "./week-progress";

// Monday 2026-09-07, written at noon Bogota time. A 4-week goal ends on the
// Monday after its week 4: 2026-10-05.
const goal = { createdAt: "2026-09-07T17:00:00Z", horizon: "2026-10-05" };

test("goalWeekProgress: the first and the last week of the horizon are numbered, out of the total", () => {
  assert.deepEqual(goalWeekProgress(goal, "2026-09-07"), { week: 1, total: 4 });
  assert.deepEqual(goalWeekProgress(goal, "2026-09-14"), { week: 2, total: 4 });
  assert.deepEqual(goalWeekProgress(goal, "2026-09-28"), { week: 4, total: 4 });
});

test("goalWeekProgress: a week past the horizon draws no number", () => {
  assert.equal(goalWeekProgress(goal, "2026-10-05"), null);
  assert.equal(goalWeekProgress(goal, "2026-11-02"), null);
});

test("goalWeekProgress: a week before the goal existed floors to week 1", () => {
  assert.deepEqual(goalWeekProgress(goal, "2026-08-31"), { week: 1, total: 4 });
  assert.deepEqual(goalWeekProgress(goal, "2026-08-03"), { week: 1, total: 4 });
});

test("goalWeekProgress: a horizon that carries no span draws no number", () => {
  assert.equal(goalWeekProgress({ ...goal, horizon: "2026-09-07" }, "2026-09-07"), null);
  assert.equal(goalWeekProgress({ ...goal, horizon: "2026-08-01" }, "2026-09-07"), null);
});

test("goalWeekProgress: a goal written late on a Sunday night counts its opening in its own civil day", () => {
  // 2026-09-14 02:00 UTC is still Sunday 2026-09-13 in Bogota: week 1 of a
  // goal opened that Sunday is still the week of Monday 2026-09-07.
  const sunday = { createdAt: "2026-09-14T02:00:00Z", horizon: "2026-10-05" };
  assert.deepEqual(goalWeekProgress(sunday, "2026-09-07"), { week: 1, total: 4 });
  assert.deepEqual(goalWeekProgress(sunday, "2026-09-28"), { week: 4, total: 4 });
});

test("endedLastDay: the day before the horizon once today has reached it, null while the goal is open", () => {
  assert.equal(endedLastDay("2026-09-24", "2026-09-27"), "2026-09-23");
  assert.equal(endedLastDay("2026-09-27", "2026-09-27"), "2026-09-26");
  assert.equal(endedLastDay("2026-09-28", "2026-09-27"), null);
});
