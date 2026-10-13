import assert from "node:assert/strict";
import test from "node:test";

import { ENDLESS_MONTHS_AHEAD, lastMonthOf, monthLine, monthRows, monthsOfSpan, partOf, plannedOf } from "./months";
import { fillPlan, type PlanInput, type PlanTask } from "./roadmap";
import { openMonthsOf, planMonthList, rhythmToMeet } from "./roadmap-read";
import { weekPlanned } from "./week-planned";

// RP-99: a goal with no end is `horizon: null`.
const TODAY = "2026-10-13";

test("ENDLESS_MONTHS_AHEAD is eleven", () => {
  assert.equal(ENDLESS_MONTHS_AHEAD, 11);
});

test("monthsOfSpan: no end runs from the opening month to eleven months past today's", () => {
  const months = monthsOfSpan("2026-09-16", null, TODAY);
  assert.equal(months[0], "2026-09-01");
  assert.equal(months[months.length - 1], "2027-09-01");
  assert.equal(months.length, 13);
});

test("monthsOfSpan: a dated goal reads as before", () => {
  assert.deepEqual(monthsOfSpan("2026-09-16", "2026-11-01"), ["2026-09-01", "2026-10-01"]);
});

test("lastMonthOf: the dated and the endless last month", () => {
  assert.equal(lastMonthOf("2026-09-16", "2026-11-01", TODAY), "2026-10-01");
  assert.equal(lastMonthOf("2026-09-16", null, TODAY), "2027-09-01");
  assert.equal(lastMonthOf("2026-09-16", null, "2026-12-31"), "2027-11-01");
});

test("plannedOf: no end has no split last month", () => {
  const input = { budgets: [], rhythm: 40, openedOn: "2026-08-01", horizon: null };
  assert.equal(plannedOf("2026-10-01", input), 40);
  assert.equal(plannedOf("2027-09-01", input), 40);
});

test("plannedOf: the opening month is still split with no end", () => {
  // 16 to 30 of September: 15 of 30 days.
  assert.equal(plannedOf("2026-09-01", { budgets: [], rhythm: 40, openedOn: "2026-09-16", horizon: null }), 20);
});

test("partOf: only the first month is part with no end", () => {
  const input = { budgets: [], rhythm: 40, openedOn: "2026-09-16", horizon: null };
  assert.equal(partOf("2026-09-01", input)?.kind, "from");
  assert.equal(partOf("2026-10-01", input), null);
  assert.equal(partOf("2027-09-01", input), null);
});

test("monthLine: pace reads the whole rhythm with no end", () => {
  const line = monthLine({ month: "2026-10-01", today: "2026-10-25", budget: null, reached: 10, rhythm: 40, openedOn: "2026-08-01", horizon: null });
  assert.equal(line.planned, 40);
  assert.equal(line.underPace, true);
});

test("monthRows: thirteen rows with no end, none split at the tail", () => {
  const rows = monthRows({ openedOn: "2026-09-16", horizon: null, today: TODAY, budgets: [], reached: new Map(), rhythm: 40 });
  assert.equal(rows.length, 13);
  assert.equal(rows[rows.length - 1].planned, 40);
});

test("weekPlanned: no end plans every day of the week", () => {
  const planned = weekPlanned({ weekStart: "2027-03-01", weekEnd: "2027-03-07", budgets: [], openedOn: "2026-08-01", horizon: null, rhythm: 31 });
  assert.equal(planned, 7);
});

let position = 0;
function task(id: string, estimate: number): PlanTask {
  position += 1;
  return { id, parentId: null, name: id, plannedMonth: null, day: null, estimate, doneOn: null, inPlan: true, createdOn: "2026-08-01", position };
}
function input(tasks: PlanTask[]): PlanInput {
  return { rhythm: 12, budgets: [], tasks, openedOn: "2026-08-01", horizon: null, today: TODAY };
}

test("fillPlan: no end draws no end day and nothing past the end", () => {
  const plan = fillPlan(input([task("a", 30), task("b", 30)]));
  assert.equal(plan.state, "planned");
  assert.equal(plan.end, null);
  assert.equal(plan.lastDay, null);
  const items = plan.months.flatMap((m) => m.items);
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => !item.pastEnd));
  assert.deepEqual(plan.unplaced, []);
});

test("fillPlan: months fill until the tasks run out", () => {
  const plan = fillPlan(input([task("a", 120)]));
  assert.equal(plan.months.length, 10);
});

test("roadmap-read: no end reads", () => {
  const base = input([task("a", 30)]);
  assert.equal(rhythmToMeet(base, 6), null);
  assert.equal(planMonthList(base, "2026-11-01").length, 1);
  const months = openMonthsOf({ openedOn: "2026-08-01", horizon: null, today: TODAY });
  assert.equal(months[0], "2026-10");
  assert.equal(months[months.length - 1], "2027-09");
});
