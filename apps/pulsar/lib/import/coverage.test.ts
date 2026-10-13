import assert from "node:assert/strict";
import test from "node:test";

import { coverage } from "./coverage";
import { normalize, type DraftGoal, type DraftTask, type ImportDraft, type RawGoal, type Source } from "./draft";
import { GOAL_NOTE_MAX } from "@/lib/validation/plan";

const task = (over: Partial<DraftTask> = {}): DraftTask => ({
  name: "Leer",
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
const goal = (over: Partial<DraftGoal> = {}): DraftGoal => ({
  key: "g1",
  parent: null,
  name: "IA aplicada",
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
  tasks: [],
  ...over,
});
const draft = (...goals: DraftGoal[]): ImportDraft => ({ version: 2, goals });
const none = new Set<string>();
const source = (lines: string[]): Source => ({ kind: "lines", lines });

// 741 lines, 142 of them blank (every fifth up to 710), 599 with text.
const plan = Array.from({ length: 741 }, (_, i) => ((i + 1) % 5 === 0 && i + 1 <= 710 ? "" : `línea ${i + 1}`));

test("the 741-line plan counts 599 lines and every one is plan, note or out", () => {
  const d = draft(goal({ src: [{ from: 1, to: 300 }], note: plan.slice(300, 500).join("\n").trim(), noteSrc: [{ from: 301, to: 500 }] }));
  const c = coverage(d, source(plan), none, none);
  assert.equal(plan.filter((l) => l.trim() !== "").length, 599);
  assert.equal(c.total, 599);
  assert.equal(c.plan, 240);
  assert.equal(c.notes, 160);
  assert.equal(c.out, 199);
  assert.equal(c.plan + c.notes + c.out, c.total);
  assert.equal(c.outLines.length, c.out);
  assert.equal(c.kind, "lines");
});

test("a line in src and in noteSrc counts once, as plan", () => {
  const lines = ["uno", "dos", "tres"];
  const d = draft(goal({ src: [{ from: 1, to: 2 }], note: "dos\ntres", noteSrc: [{ from: 2, to: 3 }] }));
  const c = coverage(d, source(lines), none, none);
  assert.deepEqual([c.plan, c.notes, c.out, c.total], [2, 1, 0, 3]);
});

test("a line nothing covers is out as notPlaced with its text", () => {
  const c = coverage(draft(goal({ src: [{ from: 1, to: 1 }] })), source(["uno", "", "tres"]), none, none);
  assert.deepEqual(c.outLines, [{ line: 3, text: "tres", reason: "notPlaced" }]);
  assert.equal(c.total, 2);
});

test("lines of an unmarked or a refused part are out with that reason", () => {
  const d = draft(goal({ src: [{ from: 1, to: 1 }], tasks: [task({ src: [{ from: 2, to: 2 }] }), task({ src: [{ from: 3, to: 3 }] })] }));
  const c = coverage(d, source(["a", "b", "c"]), new Set(["goals.0.tasks.0"]), new Set(["goals.0.tasks.1"]));
  assert.deepEqual(c.outLines, [
    { line: 2, text: "b", reason: "unmarked" },
    { line: 3, text: "c", reason: "refused" },
  ]);
  assert.equal(c.plan, 1);
});

test("a goal unmarked takes its sub-goal, its tasks and their notes out with it", () => {
  const d = draft(
    goal({ src: [{ from: 1, to: 1 }], tasks: [task({ src: [{ from: 2, to: 2 }], note: "d", noteSrc: [{ from: 4, to: 4 }] })] }),
    goal({ key: "g2", parent: "g1", src: [{ from: 3, to: 3 }] }),
  );
  const c = coverage(d, source(["a", "b", "c", "d"]), new Set(["goals.0"]), none);
  assert.deepEqual([c.plan, c.notes, c.out], [0, 0, 4]);
  assert.equal(c.outLines.every((l) => l.reason === "unmarked"), true);
});

test("lines beyond the note's ceiling are out as noteFull", () => {
  const lines = Array.from({ length: 1001 }, (_, i) => `${"x".repeat(98)}${String(i % 100).padStart(2, "0")}`);
  lines.push("y"); // 1002 lines, 100 000+ characters joined
  const raw: RawGoal = {
    key: "g1", parent: null, name: "Meta", horizon: "2027-10-01", measure: null, rate: null,
    noteSrc: [{ from: 1, to: 1002 }], noteText: null, src: [], phases: [], months: [], commitments: [], rules: [], tasks: [],
  };
  const src = source(lines);
  const { draft: d } = normalize({ goals: [raw] }, src);
  assert.equal((d.goals[0].note ?? "").length <= GOAL_NOTE_MAX, true);
  const c = coverage(d, src, none, none);
  assert.equal(c.total, 1002);
  assert.equal(c.notes + c.out, 1002);
  assert.equal(c.out > 0, true);
  assert.equal(c.outLines.every((l) => l.reason === "noteFull"), true);
  assert.equal(c.outLines.at(-1)?.line, 1002);
  assert.equal(c.outLines[0].line, 1002 - c.out + 1);
});

test("a note that fits leaves nothing out", () => {
  const lines = ["a", "b", "c"];
  const raw: RawGoal = {
    key: "g1", parent: null, name: "Meta", horizon: "2027-10-01", measure: null, rate: null,
    noteSrc: [{ from: 1, to: 3 }], noteText: null, src: [], phases: [], months: [], commitments: [], rules: [], tasks: [],
  };
  const { draft: d } = normalize({ goals: [raw] }, source(lines));
  const c = coverage(d, source(lines), none, none);
  assert.deepEqual([c.plan, c.notes, c.out], [0, 3, 0]);
});

test("from parts, the parts a src names are counted and none is out", () => {
  const d = draft(goal({ src: [{ from: 1, to: 2 }], note: "n", noteSrc: [{ from: 3, to: 3 }] }));
  const c = coverage(d, { kind: "parts", lines: null }, none, none);
  assert.deepEqual([c.kind, c.total, c.plan, c.notes, c.out], ["parts", 3, 2, 1, 0]);
});

test("898: a note the model reworded still holds the lines whose text it carries", () => {
  const lines = ["- **Pilar 1** análisis", "Pilar 2", "otra cosa"];
  const d = draft(goal({ note: "Resumen del plan\n\n* Pilar 1 análisis\nPilar 2\n\nuna cola que no es la fuente", noteSrc: [{ from: 1, to: 3 }] }));
  const c = coverage(d, source(["- Pilar 1 análisis", lines[1], lines[2]]), none, none);
  assert.deepEqual([c.plan, c.notes, c.out], [0, 2, 1]);
  assert.equal(c.outLines[0].reason, "notPlaced");
});

test("898: a line the note lacks is noteFull only when it would not fit", () => {
  const lines = ["alfa", "beta", "gamma"];
  const d = draft(goal({ note: "alfa", noteSrc: [{ from: 1, to: 3 }] }));
  const roomy = coverage(d, source(lines), none, none);
  assert.deepEqual(roomy.outLines.map((l) => [l.text, l.reason]), [["beta", "notPlaced"], ["gamma", "notPlaced"]]);
  const big = "z".repeat(GOAL_NOTE_MAX - 6);
  const full = coverage(draft(goal({ note: `alfa\n${big}`.slice(0, GOAL_NOTE_MAX - 2), noteSrc: [{ from: 1, to: 3 }] })), source(lines), none, none);
  assert.deepEqual(full.outLines.map((l) => [l.text, l.reason]), [["beta", "noteFull"], ["gamma", "noteFull"]]);
});
