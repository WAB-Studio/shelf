import assert from "node:assert/strict";
import test from "node:test";

import { releasedPlan } from "./first-rhythm";
import { fillPlan, type PlanInput, type PlanTask } from "./roadmap";

// RP-50: a goal's first rhythm returns its pending fixed tasks to the plan.

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

function planOf(tasks: PlanTask[], patch: Partial<PlanInput> = {}): PlanInput {
  return {
    rhythm: null,
    budgets: [],
    tasks,
    openedOn: "2026-08-01",
    horizon: "2027-12-01",
    today: "2026-10-11",
    ...patch,
  };
}

// The critic's plan: 10 h of tasks, four of them fixed to a month, one in 2027-10.
function criticTasks(): PlanTask[] {
  return [
    task("fixed-oct", { plannedMonth: "2026-10-01", estimate: 1 }),
    task("fixed-nov", { plannedMonth: "2026-11-01", estimate: 2 }),
    task("fixed-dec", { plannedMonth: "2026-12-01", estimate: 1 }),
    task("star", { plannedMonth: "2027-10-01", estimate: 3 }),
    task("loose-a", { estimate: 2 }),
    task("loose-b", { estimate: 1 }),
  ];
}

function withRhythm(plan: PlanInput, rhythm: number): PlanInput {
  return { ...plan, rhythm };
}

test("a pending fixed task returns to the plan: no month, in the plan", () => {
  const { plan, released } = releasedPlan(planOf([task("star", { plannedMonth: "2027-10-01", estimate: 3 })]));
  assert.equal(plan.tasks[0].plannedMonth, null);
  assert.equal(plan.tasks[0].inPlan, true);
  assert.equal(released, 1);
});

test("the plan ends where the server's plan ends: 12 h ends in this month", () => {
  const { plan } = releasedPlan(planOf(criticTasks()));
  assert.equal(fillPlan(withRhythm(plan, 12)).end?.slice(0, 7), "2026-10");
});

test("the end moves with the rhythm: 8 h ends later than 12 h, 20 h no later than 12 h", () => {
  const { plan } = releasedPlan(planOf(criticTasks()));
  const at = (rhythm: number) => fillPlan(withRhythm(plan, rhythm)).end ?? "";
  assert.ok(at(8) > at(12), `${at(8)} vs ${at(12)}`);
  assert.ok(at(20) <= at(12), `${at(20)} vs ${at(12)}`);
});

test("rhythms 8 h and 12 h give different ends once released, and the held plan stays in 2027-10", () => {
  const original = planOf(criticTasks());
  const { plan } = releasedPlan(original);
  const [slow, quick] = [fillPlan(withRhythm(plan, 8)).end ?? "", fillPlan(withRhythm(plan, 12)).end ?? ""];
  assert.notEqual(slow, quick);
  assert.ok(slow < "2027-01-01", `released 8 h ends ${slow}`);
  // The fixed 2027-10 task holds the end in October 2027 whatever the rhythm.
  for (const rhythm of [8, 12, 20]) {
    assert.equal(fillPlan(withRhythm(original, rhythm)).end?.slice(0, 7), "2027-10");
  }
});

test("a done fixed task stays fixed and is not counted", () => {
  const done = task("done", { plannedMonth: "2026-10-01", estimate: 1, doneOn: "2026-10-05" });
  const { plan, released } = releasedPlan(planOf([done]));
  assert.deepEqual(plan.tasks, [done]);
  assert.equal(released, 0);
});

test("a parent whose sub-tasks are all done stays fixed and is not counted", () => {
  const parent = task("parent", { plannedMonth: "2026-10-01" });
  const kids = [
    task("k1", { parentId: "parent", estimate: 1, doneOn: "2026-10-02" }),
    task("k2", { parentId: "parent", estimate: 1, doneOn: "2026-10-03" }),
  ];
  const { plan, released } = releasedPlan(planOf([parent, ...kids]));
  assert.equal(plan.tasks[0].plannedMonth, "2026-10-01");
  assert.equal(released, 0);
});

test("a sub-task with a month is left alone", () => {
  const sub = task("sub", { parentId: "parent", plannedMonth: "2027-10-01", estimate: 1 });
  const parent = task("parent", { estimate: 1 });
  const { plan, released } = releasedPlan(planOf([parent, sub]));
  assert.equal(plan.tasks[1].plannedMonth, "2027-10-01");
  assert.equal(released, 0);
});

test("a task with a day and no month is left alone", () => {
  const dated = task("dated", { day: "2026-10-20", inPlan: false, estimate: 1 });
  const { plan, released } = releasedPlan(planOf([dated]));
  assert.deepEqual(plan.tasks, [dated]);
  assert.equal(released, 0);
});

test("released counts the critic's four fixed tasks", () => {
  assert.equal(releasedPlan(planOf(criticTasks())).released, 4);
});

test("the input plan is not mutated", () => {
  const input = planOf(criticTasks());
  const copy = structuredClone(input);
  releasedPlan(input);
  assert.deepEqual(input, copy);
});
