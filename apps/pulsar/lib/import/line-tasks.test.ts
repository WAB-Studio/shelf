import assert from "node:assert/strict";
import test from "node:test";

import { coverage, placeLeftovers } from "./coverage";
import type { DraftGoal, DraftTask, ImportDraft, Source } from "./draft";
import { linesToTasks } from "./line-tasks";

const goal = (over: Partial<DraftGoal> = {}): DraftGoal => ({
  key: "g1",
  parent: null,
  name: "Product Designer junior",
  horizon: "2027-09-30",
  measure: { name: "horas", unit: "minutos" },
  rhythm: null,
  note: null,
  noteSrc: [],
  src: [{ from: 1, to: 1 }],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [],
  ...over,
});
const draft = (...goals: DraftGoal[]): ImportDraft => ({ version: 2, goals });
const source = (lines: string[]): Source => ({ kind: "lines", lines });

const LINES = [
  "# Product Designer junior",
  "# Reglas del plan",
  "- [ ] **10 h semanales:** 5 de caso, 3 de inglés, 2 de empleo.",
  "- [ ] **1 h · EF SET (línea base de inglés).** ✅ HECHO el 9 oct 2026",
  "Sin empleo antes de abril.",
];
const TODAY = "2026-10-12";

// What the route does with a reading: the model left lines 2 to 5 for the general's note.
function placed() {
  return placeLeftovers(draft(goal()), source(LINES));
}

test("a HECHO line leaves the note and becomes a task already done on its date", () => {
  const { draft: out } = linesToTasks(placed(), source(LINES), TODAY, { onlyDone: true });
  const g = out.goals[0];
  assert.deepEqual(
    g.tasks.map((t) => [t.name, t.estimate, t.doneOn, t.month, t.src]),
    [["EF SET · línea base de inglés", 60, "2026-10-09", "2026-10", [{ from: 4, to: 4 }]]],
  );
  assert.ok(!g.note?.includes("HECHO"));
  assert.ok(!g.note?.includes("EF SET"));
  assert.equal(g.noteSrc.some((r) => r.from <= 4 && r.to >= 4), false);
});

test("the note is clean text and keeps the lines that are not tasks", () => {
  const { draft: out } = linesToTasks(placed(), source(LINES), TODAY, { onlyDone: true });
  assert.equal(out.goals[0].note, "Reglas del plan\n10 h semanales: 5 de caso, 3 de inglés, 2 de empleo.\nSin empleo antes de abril.");
});

test("a done line is never written twice: coverage counts it once, as plan", () => {
  const { draft: out } = linesToTasks(placed(), source(LINES), TODAY, { onlyDone: true });
  const c = coverage(out, source(LINES), new Set(), new Set());
  assert.equal(c.out, 0);
  assert.equal(c.plan + c.notes, c.total);
  assert.equal(c.plan, 2);
});

test("a done day before this month keeps its day but the task sits in this month", () => {
  const lines = ["# G", "- [x] Leer HECHO el 3 ago 2026"];
  const { draft: out } = linesToTasks(placeLeftovers(draft(goal()), source(lines)), source(lines), TODAY, { onlyDone: true });
  assert.equal(out.goals[0].tasks[0].doneOn, "2026-08-03");
  assert.equal(out.goals[0].tasks[0].month, "2026-10");
  assert.equal(out.goals[0].tasks[0].estimate, null);
});

test("nothing marked done changes nothing", () => {
  const lines = ["# G", "Una regla sin marca"];
  const before = placeLeftovers(draft(goal()), source(lines));
  const { draft: out, corrections } = linesToTasks(before, source(lines), TODAY, { onlyDone: true });
  assert.deepEqual(out, before);
  assert.deepEqual(corrections, []);
});

test("a line a task already carries (task noteSrc) stays its step", () => {
  const lines = ["# G", "Tarea", "- [x] paso hecho HECHO"];
  const base = draft(
    goal({
      tasks: [{ name: "Tarea", month: "2026-10", estimate: null, note: "paso hecho HECHO", noteSrc: [{ from: 3, to: 3 }], src: [{ from: 2, to: 2 }], week: null, rule: null, children: [] }],
    }),
  );
  const { draft: out } = linesToTasks(base, source(lines), TODAY, { onlyDone: true });
  assert.equal(out.goals[0].tasks.length, 1);
});

// ---- 903c: a line shaped like a task is a task, with a correction that says so.

test("903c: a box line and a duration-first line become tasks, never note, each with a correction", () => {
  const lines = ["# G", "- [ ] Llamar al banco", "30 min Leer el capítulo", "Una regla sin forma de tarea"];
  const base = placeLeftovers(draft(goal()), source(lines));
  const { draft: out, corrections } = linesToTasks(base, source(lines), TODAY, { onlyDone: false });
  assert.deepEqual(out.goals[0].tasks.map((t) => [t.name, t.estimate, t.month, t.doneOn ?? null]), [
    ["Llamar al banco", null, "2026-10", null],
    ["Leer el capítulo", 30, "2026-10", null],
  ]);
  assert.equal(out.goals[0].note, "Una regla sin forma de tarea");
  assert.deepEqual(
    corrections.map((c) => [c.id, c.at, c.code, c.said, c.proposed, c.values, c.declined]),
    [
      ["goals.0.tasks.0:lineToTask", "goals.0.tasks.0", "lineToTask", "Llamar al banco", "Llamar al banco", { line: "2" }, "keepsPlan"],
      ["goals.0.tasks.1:lineToTask", "goals.0.tasks.1", "lineToTask", "30 min Leer el capítulo", "Leer el capítulo", { line: "3" }, "keepsPlan"],
    ],
  );
});

test("903c: the new tasks come after the tasks the model wrote, and their corrections say where", () => {
  const lines = ["# G", "Tarea", "- [ ] Nueva"];
  const own = { name: "Tarea", month: "2026-10", estimate: null, note: null, noteSrc: [], src: [{ from: 2, to: 2 }], week: null, rule: null, children: [] };
  const base = placeLeftovers(draft(goal({ tasks: [own] })), source(lines));
  const { draft: out, corrections } = linesToTasks(base, source(lines), TODAY, { onlyDone: false });
  assert.deepEqual(out.goals[0].tasks.map((t) => t.name), ["Tarea", "Nueva"]);
  assert.deepEqual(corrections.map((c) => c.at), ["goals.0.tasks.1"]);
});

test("903c: a done line is a task with no correction: the review shows it done", () => {
  const { corrections } = linesToTasks(placed(), source(LINES), TODAY, { onlyDone: false });
  assert.deepEqual(corrections.filter((c) => c.proposed.startsWith("EF SET")), []);
});

test("903c: a rate with a duration («10 h semanales») is no task by its duration, a box still is", () => {
  const lines = ["# G", "10 h semanales: 5 de caso", "- [ ] 10 h semanales: 5 de caso"];
  const { draft: out } = linesToTasks(placeLeftovers(draft(goal()), source(lines)), source(lines), TODAY, { onlyDone: false });
  assert.deepEqual(out.goals[0].tasks.map((t) => [t.name, t.estimate]), [["10 h semanales: 5 de caso", null]]);
  assert.equal(out.goals[0].note, "10 h semanales: 5 de caso");
});

test("903c: every taken line is plan in the count, and none is counted twice", () => {
  const lines = ["# G", "- [ ] Llamar al banco", "Regla"];
  const { draft: out } = linesToTasks(placeLeftovers(draft(goal()), source(lines)), source(lines), TODAY, { onlyDone: false });
  const c = coverage(out, source(lines), new Set(), new Set());
  assert.deepEqual([c.total, c.plan, c.notes, c.out], [3, 2, 1, 0]);
});

// ---- 906b, found on the real roadmap: the model made the HECHO line a sub-task, which is a task all the same.

const leaf = (name: string, line: number, over: Partial<DraftTask> = {}): DraftTask => ({
  name,
  month: "2026-10",
  estimate: null,
  note: null,
  noteSrc: [],
  src: [{ from: line, to: line }],
  week: null,
  rule: null,
  children: [],
  ...over,
});

test("906b: a task or a sub-task the model made from a done line is born done on that day", () => {
  const lines = ["# G", "Semana 1", "  - [ ] **1 h · EF SET.** ✅ HECHO el 9 oct 2026", "- [x] Leer", "- [ ] Pendiente"];
  const child = { name: "EF SET", estimate: 60, note: null, noteSrc: [], src: [{ from: 3, to: 3 }], rule: null };
  const base = draft(goal({ tasks: [leaf("Semana 1", 2, { children: [child] }), leaf("Leer", 4), leaf("Pendiente", 5)] }));
  const { draft: out, corrections } = linesToTasks(base, source(lines), TODAY, { onlyDone: false });
  const [week, read, pending] = out.goals[0].tasks;
  assert.equal(week.doneOn ?? null, null, "a task holding sub-tasks is done by them");
  assert.equal(week.children[0].doneOn, "2026-10-09");
  assert.equal(read.doneOn, TODAY);
  assert.equal(pending.doneOn ?? null, null);
  assert.deepEqual(corrections, []);
});

test("906b: a task already marked done keeps its day", () => {
  const lines = ["# G", "- [x] Leer HECHO el 3 ago 2026"];
  const base = draft(goal({ tasks: [leaf("Leer", 2, { doneOn: "2026-08-01" })] }));
  assert.equal(linesToTasks(base, source(lines), TODAY, { onlyDone: false }).draft.goals[0].tasks[0].doneOn, "2026-08-01");
});
