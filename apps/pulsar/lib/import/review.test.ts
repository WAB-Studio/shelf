import assert from "node:assert/strict";
import test from "node:test";

import { draftRefusals, type DraftGoal, type DraftTask, type ImportDraft } from "./draft";
import type { StoredDraft } from "./draft-store";
import { edit, markedDraft, nameKey, reviewTree } from "./review";

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
