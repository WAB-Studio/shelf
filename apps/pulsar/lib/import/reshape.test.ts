import assert from "node:assert/strict";
import test from "node:test";

import { decide, type Correction, type DraftGoal, type DraftTask, type ImportDraft } from "./draft";
import { reshapeTasks } from "./reshape";

const task = (name: string, over: Partial<DraftTask> = {}): DraftTask => ({
  name,
  month: "2026-10",
  estimate: null,
  note: null,
  noteSrc: [],
  src: [],
  week: null,
  rule: null,
  children: [],
  ...over,
});
const goal = (key: string, parent: string | null, name: string, tasks: DraftTask[] = [], over: Partial<DraftGoal> = {}): DraftGoal => ({
  key,
  parent,
  name,
  horizon: "2027-10-01",
  measure: { name: "horas", unit: "minutos" },
  rhythm: null,
  note: null,
  noteSrc: [],
  src: [],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks,
  ...over,
});
const draft = (...goals: DraftGoal[]): ImportDraft => ({ version: 2, goals });

const moved = (at: string, to: string): Correction => ({ id: `${at}:taskMoved`, at, code: "taskMoved", said: "General", proposed: to, values: { to }, declined: "keepsPlan" });
const lined = (at: string, line: number, said: string): Correction => ({ id: `${at}:lineToTask`, at, code: "lineToTask", said, proposed: said, values: { line: String(line) }, declined: "keepsPlan" });

const base = () => draft(goal("g", null, "General", [task("A"), task("B"), task("C")]), goal("p1", "g", "Pilar uno"), goal("p2", "g", "Pilar dos", [task("D")]));
const names = (d: ImportDraft) => d.goals.map((g) => g.tasks.map((t) => t.name));

test("a proposed move puts the task at the end of the goal it names, and the rest close up", () => {
  const out = reshapeTasks(base(), [moved("goals.0.tasks.1", "p2")], new Set());
  assert.deepEqual(names(out.draft), [["A", "C"], [], ["D", "B"]]);
});

test("moves into one goal keep the order of the corrections", () => {
  const out = reshapeTasks(base(), [moved("goals.0.tasks.2", "p1"), moved("goals.0.tasks.0", "p1")], new Set());
  assert.deepEqual(names(out.draft), [["B"], ["C", "A"], ["D"]]);
});

test("a declined move leaves the task where the plan had it", () => {
  const c = moved("goals.0.tasks.1", "p2");
  assert.deepEqual(names(reshapeTasks(base(), [c], new Set([c.id])).draft), [["A", "B", "C"], [], ["D"]]);
});

test("a move to a key no goal has, or to the goal the task is in, changes nothing", () => {
  assert.deepEqual(names(reshapeTasks(base(), [moved("goals.0.tasks.1", "nadie"), moved("goals.0.tasks.0", "g")], new Set()).draft), [["A", "B", "C"], [], ["D"]]);
});

test("the task keeps everything it had on the way", () => {
  const child = { name: "h", estimate: 30, note: null, noteSrc: [], src: [], rule: null };
  const d = draft(goal("g", null, "General", [task("A", { children: [child], week: "2026-W41", rule: "r1", doneOn: "2026-10-01" })]), goal("p", "g", "Pilar"));
  const out = reshapeTasks(d, [moved("goals.0.tasks.0", "p")], new Set());
  assert.deepEqual(out.draft.goals[1].tasks[0], d.goals[0].tasks[0]);
});

test("a path is carried to where its task went; a task before it that left shifts it up", () => {
  const out = reshapeTasks(base(), [moved("goals.0.tasks.0", "p2")], new Set());
  assert.equal(out.pathOf("goals.0.tasks.0"), "goals.2.tasks.1");
  assert.equal(out.pathOf("goals.0.tasks.2"), "goals.0.tasks.1");
  assert.equal(out.pathOf("goals.0.tasks.0.children.1"), "goals.2.tasks.1.children.1");
  assert.equal(out.pathOf("goals.2.tasks.0"), "goals.2.tasks.0");
  assert.equal(out.pathOf("goals.1"), "goals.1");
});

test("a declined line-to-task correction takes the task out and puts its line back in the note", () => {
  const d = draft(goal("g", null, "General", [task("A"), task("Llamar al banco", { src: [{ from: 4, to: 4 }] })], { note: "Regla", noteSrc: [{ from: 2, to: 2 }] }));
  const c = lined("goals.0.tasks.1", 4, "Llamar al banco");
  const out = reshapeTasks(d, [c], new Set([c.id]));
  assert.deepEqual(names(out.draft), [["A"]]);
  assert.equal(out.draft.goals[0].note, "Regla\nLlamar al banco");
  assert.deepEqual(out.draft.goals[0].noteSrc, [{ from: 2, to: 2 }, { from: 4, to: 4 }]);
  assert.equal(out.pathOf("goals.0.tasks.1"), "goals.0");
});

test("an accepted line-to-task correction changes nothing", () => {
  const d = draft(goal("g", null, "General", [task("Llamar")]));
  assert.deepEqual(reshapeTasks(d, [lined("goals.0.tasks.0", 2, "Llamar")], new Set()).draft, d);
});

test("a task whose line went back to the note is not moved, whatever was proposed", () => {
  const d = draft(goal("g", null, "General", [task("Llamar", { src: [{ from: 4, to: 4 }] })]), goal("p", "g", "Pilar"));
  const c = lined("goals.0.tasks.0", 4, "Llamar");
  const out = reshapeTasks(d, [c, moved("goals.0.tasks.0", "p")], new Set([c.id]));
  assert.deepEqual(names(out.draft), [[], []]);
});

test("decide applies the moves after the other corrections", () => {
  const rename: Correction = { id: "goals.0.tasks.1:nameShortened", at: "goals.0.tasks.1", code: "nameShortened", said: "B largo", proposed: "B", declined: "leavesOut" };
  const m = moved("goals.0.tasks.1", "p2");
  const out = decide(base(), [rename, m], new Set([rename.id]));
  assert.deepEqual(names(out), [["A", "C"], [], ["D", "B largo"]]);
});
