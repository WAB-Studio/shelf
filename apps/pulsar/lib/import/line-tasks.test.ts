import assert from "node:assert/strict";
import test from "node:test";

import { coverage, placeLeftovers } from "./coverage";
import type { DraftGoal, ImportDraft, Source } from "./draft";
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
