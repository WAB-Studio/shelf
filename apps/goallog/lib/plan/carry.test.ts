import assert from "node:assert/strict";
import test from "node:test";

import {
  monthList,
  monthOfTask,
  owedAt,
  type Task,
} from "./carry";

const OCT = "2026-10-01";
const NOV = "2026-11-01";
const DEC = "2026-12-01";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    parentId: null,
    name: id,
    plannedMonth: OCT,
    day: null,
    estimate: null,
    doneOn: null,
    ...patch,
  };
}

// The roadmap's October, in hours: 1 + 13 + 2 + 1 + 1 + 12 + 7 + 7 = 44.
function october(): Task[] {
  return [
    task("efset", { estimate: 1, doneOn: "2026-10-02" }),
    task("tutor"),
    task("elegir", { parentId: "tutor", estimate: 1, doneOn: "2026-10-03" }),
    task("sesiones", { parentId: "tutor", estimate: 6 }),
    task("grabaciones", { parentId: "tutor", estimate: 6 }),
    task("cv", { estimate: 2, doneOn: "2026-10-10" }),
    task("readme", { estimate: 1, doneOn: "2026-10-12" }),
    task("contract", { estimate: 1, doneOn: "2026-10-14" }),
    task("huyen", { estimate: 12, doneOn: "2026-10-28" }),
    task("twoptr", { estimate: 7, doneOn: "2026-10-20" }),
    task("sliding", { estimate: 7, doneOn: "2026-10-29" }),
  ];
}

const tutor = (tasks: Task[]) => tasks.filter((t) => t.parentId === "tutor");

test("monthOfTask: planned month wins, else the day's month, else none; a sub-task takes its parent's", () => {
  assert.equal(monthOfTask(task("a", { plannedMonth: DEC, day: "2026-10-05" })), DEC);
  assert.equal(monthOfTask(task("a", { plannedMonth: null, day: "2026-10-05" })), OCT);
  assert.equal(monthOfTask(task("a", { plannedMonth: null })), null);
  assert.equal(monthOfTask(task("c", { plannedMonth: null }), task("p", { plannedMonth: NOV })), NOV);
});

test("owedAt: a leaf done on the day itself still owes it, a day before it does not", () => {
  const leaf = task("a", { estimate: 30, doneOn: "2026-11-01" });
  assert.equal(owedAt(leaf, [], NOV), 30);
  assert.equal(owedAt(leaf, [], "2026-11-02"), 0);
  assert.equal(owedAt(task("b", { estimate: null }), [], NOV), 0);
});

test("owedAt: a parent owes its children's sum, never its own estimate", () => {
  const tasks = october();
  const parent = { ...tasks[1], estimate: 999 };
  assert.equal(owedAt(parent, tutor(tasks), NOV), 12);
  assert.equal(owedAt(parent, tutor(tasks), "2026-10-03"), 13);
});

test("monthList: Tutor, with Elegir tutor done, is carried into November first owing 12 h", () => {
  const tasks = [...october(), task("nov", { plannedMonth: NOV, estimate: 30 })];
  const list = monthList(tasks, NOV, "2026-11-15");
  assert.equal(list[0].task.id, "tutor");
  assert.equal(list[0].carriedFrom, OCT);
  assert.equal(list[0].owes, 12);
  assert.equal(list[0].done, false);
  assert.deepEqual(list.map((i) => i.task.id), ["tutor", "nov"]);
  assert.equal(list[1].carriedFrom, null);
});

test("monthList: a task planned for December never appears in November", () => {
  const list = monthList([...october(), task("dec", { plannedMonth: DEC, estimate: 60 })], NOV, "2026-11-15");
  assert.ok(!list.some((i) => i.task.id === "dec"));
});

test("monthList: a task with no estimate carries until done and adds 0", () => {
  const open = task("loose");
  const closed = task("closed", { doneOn: "2026-10-12" });
  const list = monthList([open, closed], NOV, "2026-11-15");
  assert.deepEqual(list.map((i) => i.task.id), ["loose"]);
  assert.equal(list[0].owes, 0);
});

test("monthList: older months first, then creation order; done reads at the month's end", () => {
  const tasks = [
    task("sep2", { plannedMonth: "2026-09-01", estimate: 1 }),
    task("oct1", { estimate: 1 }),
    task("sep1", { plannedMonth: "2026-09-01", estimate: 1 }),
  ];
  const list = monthList(tasks, NOV, "2027-03-01");
  assert.deepEqual(list.map((i) => i.task.id), ["sep2", "sep1", "oct1"]);
  const done = task("late", { plannedMonth: NOV, estimate: 1, doneOn: "2026-12-05" });
  assert.equal(monthList([done], NOV, "2027-03-01")[0].done, false);
  assert.equal(monthList([{ ...done, doneOn: "2026-11-30" }], NOV, "2027-03-01")[0].done, true);
});

test("monthList: a month after today's carries nothing; today's and a later today carry", () => {
  const tasks = [task("oct", { estimate: 315 })];
  for (const month of [NOV, "2027-03-01"]) {
    const list = monthList(tasks, month, "2026-10-01");
    assert.ok(!list.some((i) => i.carriedFrom !== null));
  }
  const own = monthList(tasks, OCT, "2026-10-01");
  assert.equal(own[0].carriedFrom, null);
  const nov = monthList(tasks, NOV, "2026-11-15");
  assert.equal(nov[0].carriedFrom, OCT);
  assert.equal(nov[0].owes, 315);
  assert.deepEqual(monthList(tasks, DEC, "2026-11-15"), []);
});

test("monthList: hasAmount reads the estimate, a parent's through its children", () => {
  const tasks = [
    task("bare"),
    task("empty", { estimate: 50 }),
    task("kid", { parentId: "empty" }),
    task("p", {}),
    task("c1", { parentId: "p", estimate: 30 }),
    task("c2", { parentId: "p" }),
    task("est", { estimate: 10 }),
  ];
  const by = Object.fromEntries(monthList(tasks, NOV, "2026-11-15").map((i) => [i.task.id, i.hasAmount]));
  assert.deepEqual(by, { bare: false, empty: false, p: true, est: true });
});

test("monthList: hasAmount on a month's own items reads the same way", () => {
  const own = { plannedMonth: NOV };
  const tasks = [
    task("p1", own),
    task("p1c", { parentId: "p1", estimate: 30 }),
    task("p2", own),
    task("p2c", { parentId: "p2" }),
    task("leaf", { ...own, estimate: 10 }),
    task("bare", own),
    task("pe", { ...own, estimate: 50 }),
    task("pec", { parentId: "pe" }),
  ];
  const list = monthList(tasks, NOV, "2026-11-15");
  assert.ok(list.every((i) => i.carriedFrom === null));
  const by = Object.fromEntries(list.map((i) => [i.task.id, i.hasAmount]));
  assert.deepEqual(by, { p1: true, p2: false, leaf: true, bare: false, pe: false });
});
