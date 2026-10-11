import assert from "node:assert/strict";
import test from "node:test";

import { dayBefore } from "@/lib/day/weeks";

import { carryShare } from "./carry";
import { fillPlan, type PlanInput, type PlanTask } from "./roadmap";
import { doneIn, openMonthsOf, planMonthList, planMonthOf, planMoved, planShare, rhythmToMeet } from "./roadmap-read";

const SEP = "2026-09-01";
const OCT = "2026-10-01";
const NOV = "2026-11-01";

let nextPosition = 0;

function task(id: string, patch: Partial<PlanTask> = {}): PlanTask {
  nextPosition += 1;
  return {
    id,
    parentId: null,
    name: id,
    plannedMonth: null,
    day: null,
    estimate: null,
    doneOn: null,
    inPlan: true,
    createdOn: "2026-08-01",
    position: nextPosition,
    ...patch,
  };
}

function input(tasks: PlanTask[], patch: Partial<PlanInput> = {}): PlanInput {
  return {
    rhythm: 12,
    budgets: [],
    tasks,
    openedOn: "2026-08-01",
    horizon: "2027-01-01",
    today: "2026-10-02",
    ...patch,
  };
}

// September closed with 6 of its 12 hours done; b and c are left.
function septemberHalf(): PlanTask[] {
  return [
    task("a", { estimate: 6, doneOn: "2026-09-10" }),
    task("b", { estimate: 6 }),
    task("c", { estimate: 12 }),
  ];
}

test("planMoved: September closed with 6 of 12 h done names September, 6, 12 and the new end", () => {
  const notice = planMoved({ ...input(septemberHalf()), seen: null });
  assert.deepEqual(notice, {
    closedMonth: SEP,
    movedDays: 15,
    closedDone: 6,
    closedAmount: 12,
    end: "2026-11-15",
  });
});

test("planMoved: closedDone sums the estimates done in the month, not the measure reached", () => {
  const tasks = [...septemberHalf(), task("d", { estimate: 3, doneOn: "2026-09-28" })];
  const notice = planMoved({ ...input(tasks), seen: null });
  assert.equal(notice?.closedDone, 9);
});

test("planMoved: seen at the closed month, a later one or none decides", () => {
  assert.equal(planMoved({ ...input(septemberHalf()), seen: SEP }), null);
  assert.equal(planMoved({ ...input(septemberHalf()), seen: OCT }), null);
  assert.notEqual(planMoved({ ...input(septemberHalf()), seen: "2026-08-01" }), null);
});

test("planMoved: no rhythm, or a month before the goal opened, reads nothing", () => {
  assert.equal(planMoved({ ...input(septemberHalf(), { rhythm: null }), seen: null }), null);
  assert.equal(planMoved({ ...input(septemberHalf(), { openedOn: "2026-10-01" }), seen: null }), null);
});

test("planMoved: a month that reached its room does not move the end", () => {
  const tasks = [task("a", { estimate: 12, doneOn: "2026-09-10" }), task("b", { estimate: 12 })];
  assert.equal(planMoved({ ...input(tasks), seen: null }), null);
});

test("planMoved: in November, with October's room reached, the notice is null", () => {
  const tasks = [
    task("a", { estimate: 6, doneOn: "2026-10-03" }),
    task("b", { estimate: 6, doneOn: "2026-10-04" }),
    task("c", { estimate: 12 }),
  ];
  assert.equal(planMoved({ ...input(tasks, { today: "2026-11-02" }), seen: null }), null);
});

// The roadmap's October, fixed to its month, copied from carry.test.ts.
function october(): PlanTask[] {
  const fixed = (id: string, patch: Partial<PlanTask> = {}) => task(id, { plannedMonth: OCT, ...patch });
  return [
    fixed("efset", { estimate: 1, doneOn: "2026-10-02" }),
    fixed("tutor"),
    task("elegir", { parentId: "tutor", plannedMonth: null, estimate: 1, doneOn: "2026-10-03" }),
    task("sesiones", { parentId: "tutor", plannedMonth: null, estimate: 6 }),
    task("grabaciones", { parentId: "tutor", plannedMonth: null, estimate: 6 }),
    fixed("cv", { estimate: 2, doneOn: "2026-10-10" }),
    fixed("huyen", { estimate: 12, doneOn: "2026-10-28" }),
    fixed("sliding", { estimate: 7, doneOn: "2026-10-29" }),
    task("nov", { plannedMonth: NOV, estimate: 30 }),
  ];
}

test("planShare: a closed month of fixed tasks equals carryShare", () => {
  const tasks = october();
  assert.deepEqual(planShare(input(tasks, { today: "2026-11-15" }), OCT), carryShare(tasks, OCT));
  assert.deepEqual(planShare(input(tasks, { today: "2026-12-05" }), NOV), carryShare(tasks, NOV));
  assert.deepEqual(planShare(input(tasks, { today: "2026-11-15" }), OCT), { carried: 12, planned: 35 });
});

test("planShare: a month not yet over has no share", () => {
  assert.equal(planShare(input(october(), { today: "2026-10-15" }), OCT), null);
});

test("planMonthList: a task left from September opens the current month, carried and first", () => {
  const fresh = task("fresh", { estimate: 3, createdOn: "2026-10-02" });
  const left = task("left", { estimate: 6 });
  const items = planMonthList(input([fresh, left], { today: "2026-10-05" }), OCT);
  assert.deepEqual(items.map((item) => item.task.id), ["left", "fresh"]);
  assert.equal(items[0].carriedFrom, SEP);
  assert.equal(items[1].carriedFrom, null);
});

test("planMonthList: a later month lists the plan's own items", () => {
  const items = planMonthList(input([task("big", { estimate: 18 })], { today: "2026-10-05" }), NOV);
  assert.deepEqual(items.map((item) => [item.task.id, item.part, item.carriedFrom]), [["big", 6, null]]);
});

test("planMonthList: a closed month reads done at its last day and adds the work done ahead", () => {
  const tasks = [
    task("a", { estimate: 4, doneOn: "2026-09-10" }),
    task("b", { estimate: 6 }),
    task("late", { estimate: 2, doneOn: "2026-10-03" }),
    task("ahead", { estimate: 2, doneOn: "2026-09-25", createdOn: "2026-09-20" }),
  ];
  const items = planMonthList(input(tasks, { today: "2026-10-15" }), SEP);
  assert.deepEqual(items.map((item) => [item.task.id, item.done]), [
    ["a", true],
    ["b", false],
    ["late", false],
    ["ahead", true],
  ]);
});

test("rhythmToMeet: the least multiple of 60 that meets the end", () => {
  const tasks = [task("big", { estimate: 2000 })];
  const base = input(tasks, { rhythm: 600, today: "2026-10-15" });
  assert.equal(rhythmToMeet(base, 60), 720);
});

test("rhythmToMeet: null when the end already fits, or fixed work past the end makes it unreachable", () => {
  const tasks = [task("big", { estimate: 2000 })];
  assert.equal(rhythmToMeet(input(tasks, { rhythm: 1200, today: "2026-10-15" }), 60), null);
  const past = [...tasks, task("late", { estimate: 60, plannedMonth: "2027-02-01" })];
  assert.equal(rhythmToMeet(input(past, { rhythm: 600, today: "2026-10-15" }), 60), null);
});

test("planShare: a task done early still counts in its own month and carries nothing", () => {
  const tasks = [
    task("early", { plannedMonth: OCT, estimate: 5, doneOn: "2026-09-20" }),
    task("left", { plannedMonth: OCT, estimate: 4 }),
  ];
  const share = planShare(input(tasks, { today: "2026-11-15" }), OCT);
  assert.deepEqual(share, carryShare(tasks, OCT));
  assert.deepEqual(share, { carried: 4, planned: 9 });
});

test("planMoved: a goal with no rhythm reads nothing even when fixed work was carried", () => {
  const tasks = [task("left", { plannedMonth: SEP, estimate: 6 })];
  assert.equal(planMoved({ ...input(tasks, { rhythm: null }), seen: null }), null);
  assert.notEqual(planMoved({ ...input(tasks), seen: null }), null);
});

test("planShare: a task created today and fixed to a closed month counts in that month's share", () => {
  const tasks = [
    task("kept", { plannedMonth: SEP, estimate: 6, doneOn: "2026-09-10", createdOn: "2026-10-20" }),
    task("owed", { plannedMonth: SEP, estimate: 4, createdOn: "2026-10-20" }),
    task("loose", { estimate: 8, createdOn: "2026-10-20" }),
  ];
  const share = planShare(input(tasks, { today: "2026-10-20" }), SEP);
  assert.deepEqual(share, { carried: 4, planned: 10 });
  assert.deepEqual(share, carryShare(tasks, SEP));
});

test("planMoved: a goal opened in the closed month still reads its notice", () => {
  // Opened on the 2nd: September plans 11 of 12 (RP-74), so the plan still moves.
  const notice = planMoved({ ...input(septemberHalf(), { openedOn: "2026-09-02" }), seen: null });
  assert.equal(notice?.closedMonth, SEP);
});

test("rhythmToMeet: a total that is no multiple of the step rounds up to the step that holds it", () => {
  const tasks = [task("hundred", { estimate: 100 })];
  const tight = input(tasks, { rhythm: 60, today: "2026-10-15", horizon: NOV });
  assert.equal(rhythmToMeet(tight, 60), 120);
});

test("planMonthOf: a task fixed to December reads the month the plan would give it", () => {
  const tasks = [task("a", { estimate: 6 }), task("pinned", { plannedMonth: "2026-12-01", estimate: 4 })];
  assert.equal(planMonthOf(input(tasks), "pinned"), OCT);
  assert.equal(planMonthOf(input([task("none", { estimate: 4 })], { rhythm: null }), "none"), null);
});

test("openMonthsOf: from this month to the goal's last, nothing once the goal ended", () => {
  assert.deepEqual(openMonthsOf(input([], { horizon: "2027-01-01" })), ["2026-10", "2026-11", "2026-12"]);
  assert.deepEqual(openMonthsOf(input([], { horizon: "2026-10-02" })), []);
});

test("openMonthsOf: a goal that opens in a future month starts there", () => {
  assert.deepEqual(openMonthsOf(input([], { openedOn: "2026-12-10", horizon: "2027-03-01" })), [
    "2026-12",
    "2027-01",
    "2027-02",
  ]);
});

function doneMix(): PlanTask[] {
  return [
    task("leaf-oct", { estimate: 300, doneOn: "2026-10-03" }),
    task("parent"),
    task("sub-done", { parentId: "parent", estimate: 120, doneOn: "2026-10-10" }),
    task("sub-open", { parentId: "parent", estimate: 60 }),
    task("leaf-sep", { estimate: 90, doneOn: "2026-09-30" }),
    task("leaf-none", { doneOn: "2026-10-04" }),
  ];
}

test("doneIn: leaves and done sub-tasks of an undone parent count in their month only", () => {
  assert.equal(doneIn(input(doneMix()), OCT), 420);
  assert.equal(doneIn(input(doneMix()), SEP), 90);
});

test("doneIn: a parent adds nothing of its own beside its sub-tasks", () => {
  const tasks = [
    task("p", { estimate: 500, doneOn: "2026-10-05" }),
    task("s1", { parentId: "p", estimate: 30, doneOn: "2026-10-06" }),
    task("s2", { parentId: "p", estimate: 40, doneOn: "2026-10-07" }),
  ];
  assert.equal(doneIn(input(tasks), OCT), 70);
});

test("doneIn: the last day of the month counts, the first of the next does not", () => {
  const tasks = [
    task("last", { estimate: 10, doneOn: "2026-10-31" }),
    task("next", { estimate: 7, doneOn: "2026-11-01" }),
  ];
  assert.equal(doneIn(input(tasks), OCT), 10);
  assert.equal(doneIn(input(tasks), NOV), 7);
});

test("planMoved: closedDone counts a done sub-task under an undone parent, never the parent", () => {
  const tasks = [
    task("p", { estimate: 50, doneOn: "2026-09-12" }),
    task("s", { parentId: "p", estimate: 6, doneOn: "2026-09-10" }),
    task("t", { parentId: "p", estimate: 6 }),
    task("c", { estimate: 12 }),
  ];
  assert.equal(planMoved({ ...input(tasks), seen: null })?.closedDone, 6);
});

test("planShare: what was carried never passes what the month planned, task by task (RP-50)", () => {
  // September's room is 8 h: the 6 h task sits whole, the 4 h one has 2 h in September and 2 h in October.
  const tasks = [task("six", { estimate: 6 }), task("four", { estimate: 4 })];
  const share = planShare(input(tasks, { rhythm: 8, today: "2026-10-15" }), SEP);
  assert.deepEqual(share, { carried: 8, planned: 8 });
});

test("rhythmToMeet: a plan that ends on the goal's last day asks for no faster rhythm (RP-52, RP-53)", () => {
  const tasks = [task("all-october", { estimate: 12 })];
  const fits = input(tasks, { rhythm: 12, horizon: NOV, today: "2026-10-02" });
  assert.equal(dayBefore(fits.horizon), "2026-10-31");
  assert.equal(fillPlan(fits).end, "2026-10-31");
  assert.equal(rhythmToMeet(fits, 12), null);
});
