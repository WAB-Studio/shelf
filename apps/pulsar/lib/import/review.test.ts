import assert from "node:assert/strict";
import test from "node:test";

import { draftRefusals, type DraftGoal, type DraftTask, type ImportDraft } from "./draft";
import type { StoredDraft } from "./draft-store";
import { edit, editedCorrections, goalHorizonRefusal, markedDraft, nameKey, remapUnmarked, reviewTree, weekdaysIn } from "./review";

const TODAY = "2026-10-15";

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
  name: "Meta",
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
const stored = (d: ImportDraft, over: Partial<StoredDraft> = {}): StoredDraft => ({
  version: 2,
  via: "model",
  draft: d,
  corrections: [],
  notices: [],
  source: { kind: "lines", lines: [] },
  sourceName: null,
  unmarked: [],
  declined: [],
  ...over,
});
const review = (d: ImportDraft, over: Partial<StoredDraft> = {}, names: string[] = []) => reviewTree(stored(d, over), TODAY, names);

const phase = { aim: "Evals", startsOn: "2026-10-16", endsOn: "2026-12-31", src: [] };
const three = draft(
  goal({ key: "g1", name: "General", months: [], phases: [] }),
  goal({ key: "g2", parent: "g1", name: "Grande A", phases: [phase], tasks: [task({ name: "T1", estimate: 60, children: [{ name: "S1", estimate: 30, note: null, noteSrc: [], src: [], rule: null }] })] }),
  goal({ key: "g3", parent: "g2", name: "Pequeña", months: [{ month: "2026-11", amount: 120, src: [] }] }),
  goal({ key: "g4", parent: "g1", name: "Grande B" }),
);

test("the tree is drawn in preorder: general, large with its own, small beneath, with depths 0 to 4", () => {
  const { nodes } = review(three);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.label, n.depth]),
    [
      ["group", "General", 0],
      ["group", "Grande A", 1],
      ["phase", "Evals", 2],
      ["task", "T1", 2],
      ["subTask", "S1", 3],
      ["goal", "Pequeña", 2],
      ["month", "2026-11", 3],
      ["goal", "Grande B", 1],
    ],
  );
  assert.deepEqual(nodes.filter((n) => n.kind === "group" || n.kind === "goal").map((n) => n.level), ["general", "large", "small", "large"]);
  assert.deepEqual(nodes.find((n) => n.kind === "subTask")?.figure, { amount: 30, unit: "minutos" });
});

test("a note and a rhythm are nodes of their goal", () => {
  const { nodes } = review(draft(goal({ rhythm: 600, note: "contexto" })));
  assert.deepEqual(nodes.map((n) => n.kind), ["goal", "rhythm", "note"]);
  assert.deepEqual(nodes[1].figure, { amount: 600, unit: "minutos" });
  assert.equal(nodes[2].label, "contexto");
});

test("a deepest goal sits at depth 4 with its sub-task", () => {
  const { nodes } = review(draft(goal(), goal({ key: "g2", parent: "g1" }), goal({ key: "g3", parent: "g2", tasks: [task({ children: [{ name: "S", estimate: null, note: null, noteSrc: [], src: [], rule: null }] })] })));
  assert.equal(Math.max(...nodes.map((n) => n.depth)), 4);
});

test("a refused part is not markable, not marked, and says why; the rest is sent", () => {
  const d = draft(goal({ horizon: "2026-01-01" }), goal({ key: "g2", tasks: [task({ name: "x".repeat(130) }), task({ name: "Bien" })] }));
  const r = review(d);
  const refused = r.nodes.find((n) => n.path === "goals.1.tasks.0");
  assert.equal(refused?.refusal?.key, "day.errors.oneOffNameTooLong");
  assert.equal(refused?.markable, false);
  assert.equal(refused?.marked, false);
  assert.equal(r.nodes.find((n) => n.path === "goals.0")?.refusal?.key, "import.errors.horizonPast");
  assert.equal(r.nodes.find((n) => n.path === "goals.1.tasks.1")?.marked, true);
  assert.deepEqual(r.toSend.goals.map((g) => g.key), ["g2"]);
  assert.deepEqual(r.toSend.goals[0].tasks.map((t) => t.name), ["Bien"]);
  assert.equal(r.createCount, 2);
  assert.equal(r.nothingWritable, false);
});

test("a plan with every part refused has nothing writable and creates 0", () => {
  const r = review(draft(goal({ horizon: "2026-01-01" }), goal({ key: "g2", horizon: "2026-02-01" })));
  assert.equal(r.nothingWritable, true);
  assert.equal(r.createCount, 0);
  assert.equal(r.toSend.goals.length, 0);
});

test("what is sent passes the refusals with none left", () => {
  const fixtures: ImportDraft[] = [
    three,
    draft(goal({ horizon: "2026-01-01" }), goal({ key: "g2", parent: "g1" }), goal({ key: "g3" })),
    draft(goal(), goal({ key: "g2", parent: "g1" }), goal({ key: "g3", parent: "g2" }), goal({ key: "g4", parent: "g3" }), goal({ key: "g5", parent: "g9" })),
    draft(goal({ key: "g1", rhythm: 600, months: [{ month: "2026-11", amount: 5, src: [] }] }), goal({ key: "g2", parent: "g1", horizon: "2028-01-01" })),
    draft(goal({ tasks: [task({ estimate: 60, children: [{ name: "c", estimate: 5, note: null, noteSrc: [], src: [], rule: null }] }), task({ month: "2031-01" })] })),
    draft(goal({ measure: null, tasks: [task({ estimate: 5 })], commitments: [{ name: "q", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "quantity", targetQuantity: 3, unit: "u", src: [] }] })),
  ];
  for (const f of fixtures) {
    assert.deepEqual(draftRefusals(review(f).toSend, TODAY), [], JSON.stringify(f));
  }
  const unmarkedParent = review(three, { unmarked: ["goals.1"] }).toSend;
  assert.deepEqual(unmarkedParent.goals.map((g) => g.key), ["g1", "g4"]);
  assert.deepEqual(draftRefusals(unmarkedParent, TODAY), []);
});

test("a goal unmarked takes the goals inside it; a declined proposal is not applied", () => {
  const r = review(three, { unmarked: ["goals.1"] });
  assert.equal(r.nodes.find((n) => n.path === "goals.2")?.marked, false);
  assert.equal(r.nodes.find((n) => n.path === "goals.1.tasks.0")?.marked, false);
  assert.equal(r.nodes.find((n) => n.path === "goals.3")?.marked, true);
});

test("a goal an open goal already names starts unmarked when nothing was marked yet", () => {
  const r = review(draft(goal({ name: "Inglés" }), goal({ key: "g2", name: "Otra" })), { unmarked: null }, ["ingles".replace("i", "I").replace("ngles", "nglés")]);
  assert.deepEqual(r.toSend.goals.map((g) => g.name), ["Otra"]);
});

test("corrections sit on the node where they happened", () => {
  const c = { id: "goals.1.tasks.0:parentEstimateDropped", at: "goals.1.tasks.0", code: "parentEstimateDropped" as const, said: "9", proposed: "", declined: "leavesOut" as const };
  const r = review(three, { corrections: [c] });
  assert.deepEqual(r.nodes.find((n) => n.path === "goals.1.tasks.0")?.corrections.map((x) => x.id), [c.id]);
  assert.equal(r.nodes.filter((n) => n.corrections.length > 0).length, 1);
});

test("the proposals of the check are applied unless declined", () => {
  const d = draft(goal({ months: [{ month: "2026-10", amount: 100, src: [] }] }));
  const c = { id: "goals.0.months.0:monthSumDiffers", at: "goals.0.months.0", code: "monthSumDiffers" as const, said: "100", proposed: "150", declined: "keepsPlan" as const };
  assert.equal(review(d, { corrections: [c] }).toSend.goals[0].months[0].amount, 150);
  assert.equal(review(d, { corrections: [c], declined: [c.id] }).toSend.goals[0].months[0].amount, 100);
});

test("edit changes the one part and nothing else", () => {
  const before = JSON.stringify(three);
  const named = edit(three, "goals.1.tasks.0", { name: "Nueva" });
  assert.equal(named.goals[1].tasks[0].name, "Nueva");
  assert.equal(named.goals[1].tasks[0].estimate, 60);
  assert.equal(edit(three, "goals.2.months.0", { amount: 300 }).goals[2].months[0].amount, 300);
  assert.equal(edit(three, "goals.2.months.0", { month: "2026-12" }).goals[2].months[0].month, "2026-12");
  assert.equal(edit(three, "goals.1.tasks.0.children.0", { amount: 45 }).goals[1].tasks[0].children[0].estimate, 45);
  assert.equal(edit(three, "goals.1.tasks.0", { amount: 90 }).goals[1].tasks[0].estimate, 90);
  assert.equal(edit(three, "goals.0", { name: "Otro" }).goals[0].name, "Otro");
  assert.equal(edit(draft(goal({ rhythm: 60 })), "goals.0.rhythm", { amount: 90 }).goals[0].rhythm, 90);
  const only = edit(three, "goals.1", { name: "Z" });
  assert.deepEqual(only.goals.map((g) => g.name), ["General", "Z", "Pequeña", "Grande B"]);
  assert.equal(JSON.stringify(three), before);
  assert.equal(JSON.stringify({ ...only, goals: only.goals.map((g, i) => (i === 1 ? { ...g, name: "Grande A" } : g)) }), before);
});

test("coverage rides along: the counts are the draft's own", () => {
  const d = draft(goal({ src: [{ from: 1, to: 2 }] }));
  const r = review(d, { source: { kind: "lines", lines: ["a", "b", "c"] } });
  assert.deepEqual([r.coverage.plan, r.coverage.out, r.coverage.total], [2, 1, 3]);
});

// ---- 903

test("903: a phase the person unticked is not sent", () => {
  const d = draft(goal({ phases: [phase, { ...phase, aim: "Otra", startsOn: "2027-01-01", endsOn: "2027-03-01" }] }));
  const sent = markedDraft(d, new Set(["goals.0.phases.0"]), new Set());
  assert.deepEqual(sent.goals[0].phases.map((p) => p.aim), ["Otra"]);
});

test("903: renaming a commitment or a phase in its sheet changes that part and no other", () => {
  const c = { name: "Correr", cadenceKind: "daily" as const, cadenceWeekdays: null, cadenceN: null, satisfaction: "tap" as const, targetQuantity: null, unit: null, src: [] };
  const d = draft(goal({ phases: [phase], commitments: [c, { ...c, name: "Leer" }] }));
  const renamed = edit(d, "goals.0.commitments.1", { name: "Leer más" });
  assert.deepEqual(renamed.goals[0].commitments.map((x) => x.name), ["Correr", "Leer más"]);
  assert.equal(edit(d, "goals.0.phases.0", { name: "Nueva" }).goals[0].phases[0].aim, "Nueva");
  assert.equal(d.goals[0].commitments[1].name, "Leer");
});

test("903: a goal name is compared composed, trimmed, with spaces collapsed and without case", () => {
  assert.equal(nameKey("Ordenar la casa"), nameKey("  ordenar   LA casa "));
  assert.equal(nameKey("Ingle\u0301s"), nameKey("Inglés"));
  assert.equal(nameKey("Inglés").length, 6);
  assert.notEqual(nameKey("Ingles"), nameKey("Inglés"));
});

// ---- 906: the review changes a commitment's cadence and amount, and a goal's horizon.

const commitment = (over: Partial<DraftGoal["commitments"][number]> = {}): DraftGoal["commitments"][number] => ({
  name: "Inglés pasivo",
  cadenceKind: "times_per_week",
  cadenceWeekdays: null,
  cadenceN: 1,
  satisfaction: "quantity",
  targetQuantity: 30,
  unit: "minutos",
  src: [],
  ...over,
});
const withCommitment = (over: Partial<DraftGoal["commitments"][number]> = {}) => draft(goal({ commitments: [commitment(over)] }));

test("906: a cadence edit to days writes the days and no count", () => {
  const next = edit(withCommitment(), "goals.0.commitments.0", { cadence: { kind: "weekdays", weekdays: [7, 3, 3], n: 4 } });
  const c = next.goals[0].commitments[0];
  assert.deepEqual([c.cadenceKind, c.cadenceWeekdays, c.cadenceN], ["weekdays", [3, 7], null]);
});

test("906: a cadence edit to a count writes the count and no days", () => {
  const start = withCommitment({ cadenceKind: "weekdays", cadenceWeekdays: [7], cadenceN: null });
  const c = edit(start, "goals.0.commitments.0", { cadence: { kind: "every_n_days", weekdays: [7], n: 3 } }).goals[0].commitments[0];
  assert.deepEqual([c.cadenceKind, c.cadenceWeekdays, c.cadenceN], ["every_n_days", null, 3]);
  const daily = edit(start, "goals.0.commitments.0", { cadence: { kind: "daily", weekdays: [7], n: 3 } }).goals[0].commitments[0];
  assert.deepEqual([daily.cadenceKind, daily.cadenceWeekdays, daily.cadenceN], ["daily", null, null]);
});

test("906: an edited cadence leaves a draft the refusals accept; days left empty are refused by name", () => {
  const ok = edit(withCommitment(), "goals.0.commitments.0", { cadence: { kind: "weekdays", weekdays: [7], n: null } });
  assert.deepEqual(draftRefusals(ok, TODAY), []);
  const empty = edit(withCommitment(), "goals.0.commitments.0", { cadence: { kind: "weekdays", weekdays: [], n: null } });
  assert.deepEqual(draftRefusals(empty, TODAY).map((r) => [r.path, r.key]), [["goals.0.commitments.0", "plan.errors.weekdaysEmpty"]]);
});

test("906: the amount of a commitment is its target, and a tap has none to change", () => {
  assert.equal(edit(withCommitment(), "goals.0.commitments.0", { amount: 45 }).goals[0].commitments[0].targetQuantity, 45);
  const tap = withCommitment({ satisfaction: "tap", targetQuantity: null, unit: null });
  assert.equal(edit(tap, "goals.0.commitments.0", { amount: 45 }).goals[0].commitments[0].targetQuantity, null);
});

test("906: a horizon edit moves the goal's end and nothing else", () => {
  const start = draft(goal({ name: "A" }), goal({ key: "g2", name: "B" }));
  const next = edit(start, "goals.1", { horizon: "2027-03-01" });
  assert.deepEqual(next.goals.map((g) => g.horizon), ["2027-10-01", "2027-03-01"]);
});

test("906: the edit never touches the draft it was given", () => {
  const start = withCommitment();
  edit(start, "goals.0.commitments.0", { cadence: { kind: "daily", weekdays: [], n: null } });
  assert.equal(start.goals[0].commitments[0].cadenceKind, "times_per_week");
});

test("906: a horizon past the end of a goal inside is refused by the goal inside, with its name and day", () => {
  const d = draft(goal({ key: "g1", name: "General", horizon: "2027-10-01" }), goal({ key: "g2", parent: "g1", name: "Inglés B1", horizon: "2027-10-01" }));
  assert.deepEqual(goalHorizonRefusal(d, 0, "2027-06-01", TODAY), { key: "tree.errors.belowEndsLater", values: { name: "Inglés B1", date: "2027-09-30" } });
});

test("906: a horizon past the goal above, or already gone, is refused; a fitting one is not", () => {
  const d = draft(goal({ key: "g1", name: "General", horizon: "2027-06-01" }), goal({ key: "g2", parent: "g1", name: "Inglés B1", horizon: "2027-03-01" }));
  assert.deepEqual(goalHorizonRefusal(d, 1, "2027-09-01", TODAY), { key: "tree.errors.endPastAbove", values: { name: "General", date: "2027-05-31" } });
  assert.deepEqual(goalHorizonRefusal(d, 1, TODAY, TODAY), { key: "import.errors.horizonPast", values: {} });
  assert.equal(goalHorizonRefusal(d, 1, "2027-05-01", TODAY), null);
  assert.equal(goalHorizonRefusal(d, 0, "2027-12-01", TODAY), null);
});

test("906: the corrections a person's edit overrides are dropped, the others stay", () => {
  const cs = [
    { id: "goals.0.commitments.0:cadenceToWeekdays", at: "goals.0.commitments.0", code: "cadenceToWeekdays" as const, said: "", proposed: "", declined: "leavesOut" as const },
    { id: "goals.0.commitments.0:cadenceClamped", at: "goals.0.commitments.0", code: "cadenceClamped" as const, said: "", proposed: "", declined: "leavesOut" as const },
    { id: "goals.0.commitments.1:cadenceClamped", at: "goals.0.commitments.1", code: "cadenceClamped" as const, said: "", proposed: "", declined: "leavesOut" as const },
    { id: "goals.0:endWithinAbove", at: "goals.0", code: "endWithinAbove" as const, said: "", proposed: "", declined: "leavesOut" as const },
    { id: "goals.1:endWithinAbove", at: "goals.1", code: "endWithinAbove" as const, said: "", proposed: "", declined: "leavesOut" as const },
  ];
  assert.deepEqual(editedCorrections(cs, "goals.0.commitments.0", { cadence: { kind: "daily", weekdays: [], n: null } }).map((c) => c.id), [
    "goals.0.commitments.1:cadenceClamped",
    "goals.0:endWithinAbove",
    "goals.1:endWithinAbove",
  ]);
  assert.deepEqual(editedCorrections(cs, "goals.0", { horizon: "2027-01-01" }).map((c) => c.id), cs.slice(0, 3).concat(cs.slice(4)).map((c) => c.id));
  assert.equal(editedCorrections(cs, "goals.0", { name: "x" }).length, 5);
});

test("906: the weekday a plan line names is found, in any case and with or without an accent", () => {
  assert.deepEqual(weekdaysIn("Inglés pasivo · Domingo · 30 min"), [{ word: "Domingo", day: 7 }]);
  assert.deepEqual(weekdaysIn("el miercoles y el SÁBADO"), [{ word: "miercoles", day: 3 }, { word: "SÁBADO", day: 6 }]);
  assert.deepEqual(weekdaysIn("cada semana"), []);
});

test("906: a task marked done shows its day in the review", () => {
  const { nodes } = review(draft(goal({ tasks: [task({ name: "EF SET", doneOn: "2026-10-09" }), task({ name: "Otra" })] })));
  assert.deepEqual(nodes.filter((n) => n.kind === "task").map((n) => [n.label, n.doneOn]), [["EF SET", "2026-10-09"], ["Otra", null]]);
});

// ---- 903c: tasks the second pass moved are drawn where they went, with their corrections.

const movedDraft = () =>
  draft(
    goal({ key: "g", name: "General", tasks: [task({ name: "A" }), task({ name: "B" })] }),
    goal({ key: "p", parent: "g", name: "Pilar", tasks: [task({ name: "D" })] }),
  );
const moveB = { id: "goals.0.tasks.1:taskMoved", at: "goals.0.tasks.1", code: "taskMoved" as const, said: "General", proposed: "Pilar", values: { to: "p", name: "B" }, declined: "keepsPlan" as const };

test("903c: a moved task is a node of the goal it went to, and its correction hangs on it", () => {
  const { nodes } = review(movedDraft(), { corrections: [moveB] });
  assert.deepEqual(nodes.filter((n) => n.kind === "task").map((n) => [n.path, n.label]), [["goals.0.tasks.0", "A"], ["goals.1.tasks.0", "D"], ["goals.1.tasks.1", "B"]]);
  assert.deepEqual(nodes.find((n) => n.path === "goals.1.tasks.1")?.corrections.map((c) => c.id), [moveB.id]);
  assert.deepEqual(review(movedDraft(), { corrections: [moveB] }).corrections.map((c) => c.at), ["goals.1.tasks.1"]);
});

test("903c: a declined move leaves the task in the goal that held it, and its correction there", () => {
  const { nodes } = review(movedDraft(), { corrections: [moveB], declined: [moveB.id] });
  assert.deepEqual(nodes.filter((n) => n.kind === "task").map((n) => n.path), ["goals.0.tasks.0", "goals.0.tasks.1", "goals.1.tasks.0"]);
  assert.deepEqual(nodes.find((n) => n.path === "goals.0.tasks.1")?.corrections.map((c) => c.id), [moveB.id]);
});

test("903c: what is sent has the task under the goal it went to", () => {
  const { toSend } = review(movedDraft(), { corrections: [moveB] });
  assert.deepEqual(toSend.goals.map((g) => g.tasks.map((t) => t.name)), [["A"], ["D", "B"]]);
});

test("903c: unmarked paths follow a task when a move is declined or accepted again", () => {
  const withMove = stored(movedDraft(), { corrections: [moveB], declined: [], unmarked: ["goals.1.tasks.1"] });
  assert.deepEqual(remapUnmarked(withMove, new Set([moveB.id]), ["goals.1.tasks.1"]), ["goals.0.tasks.1"]);
  const without = stored(movedDraft(), { corrections: [moveB], declined: [moveB.id] });
  assert.deepEqual(remapUnmarked(without, new Set(), ["goals.0.tasks.1", "goals.1"]), ["goals.1.tasks.1", "goals.1"]);
});

test("906b: a sub-task marked done shows its day too", () => {
  const child = { name: "EF SET", estimate: 60, note: null, noteSrc: [], src: [], rule: null, doneOn: "2026-10-09" };
  const { nodes } = review(draft(goal({ tasks: [task({ name: "Semana", children: [child] })] })));
  assert.deepEqual(nodes.filter((n) => n.kind === "subTask").map((n) => [n.label, n.doneOn]), [["EF SET", "2026-10-09"]]);
});
