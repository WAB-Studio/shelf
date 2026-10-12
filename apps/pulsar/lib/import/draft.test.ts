import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { parseTemplateV1 as parseTemplate } from "./template";
import { draftRefusals, importDraftJsonSchema, importDraftSchema, inMinutes, phaseCuts, phaseDrops, strayEstimates, withCutPhases, withoutStrayEstimates, type ImportDraftV1 } from "./draft";

import { decide, draftRefusals as refusalsOf, draftV2Schema, normalize, rawDraftJsonSchema, rawDraftSchema, type DraftGoal, type ImportDraft, type RawGoal, type RawTask, type Source } from "./draft";

const TODAY = "2026-10-15";

function goal(over: Partial<ImportDraftV1["goals"][number]> = {}): ImportDraftV1["goals"][number] {
  return {
    name: "IA aplicada",
    horizon: "2027-10-01",
    rhythm: null,
    measure: { name: "horas de estudio", unit: "minutos" },
    phases: [{ aim: "Evals", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
    months: [{ month: "2026-10", amount: 720 }],
    commitments: [
      { name: "Inglés", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "tap", targetQuantity: null, unit: null },
    ],
    tasks: [{ name: "Leer", month: "2026-10", estimate: null, children: [{ name: "Cap. 1", estimate: 60 }] }],
    ...over,
  };
}

const draft = (...goals: ImportDraftV1["goals"]): ImportDraftV1 => ({ goals });

function errorsOf(input: unknown): string[] {
  const parsed = importDraftSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

test("importDraftSchema: a whole draft passes", () => {
  assert.deepEqual(errorsOf(draft(goal())), []);
});

test("importDraftSchema: 0 goals and 13 goals are refused, 12 pass", () => {
  assert.deepEqual(errorsOf(draft()), ["import.errors.empty"]);
  assert.deepEqual(errorsOf(draft(...Array.from({ length: 13 }, () => goal()))), ["import.errors.draftInvalid"]);
  assert.deepEqual(errorsOf(draft(...Array.from({ length: 12 }, () => goal()))), []);
});

test("importDraftSchema: an unknown key is refused at the top, in a goal and in a child", () => {
  assert.notDeepEqual(errorsOf({ ...draft(goal()), extra: 1 }), []);
  assert.notDeepEqual(errorsOf(draft({ ...goal(), extra: 1 } as never)), []);
  const nested = goal({ tasks: [{ name: "Leer", month: "2026-10", estimate: null, children: [{ name: "a", estimate: null, extra: 1 } as never] }] });
  assert.notDeepEqual(errorsOf(draft(nested)), []);
});

test("importDraftSchema: each field answers with its form's own key", () => {
  assert.deepEqual(errorsOf(draft(goal({ name: "  " }))), ["plan.errors.nameEmpty"]);
  assert.deepEqual(errorsOf(draft(goal({ horizon: "2027-02-31" }))), ["plan.errors.horizonInvalid"]);
  assert.deepEqual(errorsOf(draft(goal({ months: [{ month: "2026-13", amount: 1 }] }))), ["month.errors.monthInvalid"]);
  assert.deepEqual(errorsOf(draft(goal({ months: [{ month: "2026-10", amount: -1 }] }))), ["month.errors.amountInvalid"]);
  assert.deepEqual(errorsOf(draft(goal({ months: [{ month: "2026-10", amount: 1_000_001 }] }))), ["month.errors.amountInvalid"]);
  assert.deepEqual(
    errorsOf(draft(goal({ tasks: [{ name: "x", month: "2026-10", estimate: 0, children: [] }] }))),
    ["month.errors.estimateInvalid"],
  );
  assert.deepEqual(
    errorsOf(draft(goal({ phases: [{ aim: "x", startsOn: "2026-12-31", endsOn: "2026-10-01" }] }))),
    ["plan.errors.phaseBackwards"],
  );
});

test("importDraftSchema: a commitment answers as the commitment form does", () => {
  const base = { name: "x", cadenceKind: "daily" as const, cadenceWeekdays: null, cadenceN: null, satisfaction: "tap" as const, targetQuantity: null, unit: null };
  const only = (c: object) => errorsOf(draft(goal({ commitments: [{ ...base, ...c }] })));
  assert.deepEqual(only({ cadenceKind: "times_per_week", cadenceN: 8 }), ["plan.errors.timesPerWeekInvalid"]);
  assert.deepEqual(only({ cadenceKind: "weekdays", cadenceWeekdays: [] }), ["plan.errors.weekdaysEmpty"]);
  assert.deepEqual(only({ satisfaction: "quantity", targetQuantity: 120, unit: "min" }), []);
  assert.deepEqual(only({ satisfaction: "evidence" }).length > 0, true);
});

test("importDraftJsonSchema: closes every object and names the goals", () => {
  const json = JSON.stringify(importDraftJsonSchema);
  assert.equal((importDraftJsonSchema as { properties: Record<string, unknown> }).properties.goals !== undefined, true);
  assert.equal(json.includes('"additionalProperties":false'), true);
});

test("draftRefusals: a clean draft refuses nothing", () => {
  assert.deepEqual(draftRefusals(draft(goal()), TODAY), []);
});

test("draftRefusals: a horizon on or before today, and the goal's months are not also refused", () => {
  assert.deepEqual(draftRefusals(draft(goal({ horizon: TODAY, phases: [] })), TODAY), [
    { path: "goals.0.horizon", key: "import.errors.horizonPast" },
  ]);
  const past = draftRefusals(draft(goal({ horizon: "2026-01-01" })), TODAY);
  assert.deepEqual(past.map((r) => r.key), ["import.errors.horizonPast", "plan.errors.phasePastHorizon"]);
  assert.deepEqual(draftRefusals(draft(goal({ horizon: "2026-10-16" })), TODAY).map((r) => r.key), ["plan.errors.phasePastHorizon"]);
});

test("draftRefusals: a phase past the horizon", () => {
  const g = goal({ horizon: "2027-01-01", phases: [{ aim: "x", startsOn: "2026-12-01", endsOn: "2027-01-02" }] });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.phases.0", key: "plan.errors.phasePastHorizon" }]);
  const edge = goal({ horizon: "2027-01-01", phases: [{ aim: "x", startsOn: "2026-12-01", endsOn: "2027-01-01" }] });
  assert.deepEqual(draftRefusals(draft(edge), TODAY), []);
});

test("draftRefusals: two phases sharing a day", () => {
  const g = goal({
    phases: [
      { aim: "a", startsOn: "2026-10-01", endsOn: "2026-11-30" },
      { aim: "b", startsOn: "2026-11-30", endsOn: "2026-12-31" },
    ],
  });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.phases.1", key: "plan.errors.phaseOverlap" }]);
});

test("draftRefusals: a month or a task outside the span from today's month to the horizon's last day", () => {
  const g = goal({
    horizon: "2027-01-01",
    months: [
      { month: "2026-09", amount: 1 },
      { month: "2026-10", amount: 1 },
      { month: "2026-12", amount: 1 },
      { month: "2027-01", amount: 1 },
    ],
    tasks: [
      { name: "a", month: "2027-01", estimate: null, children: [] },
      { name: "b", month: "2026-12", estimate: null, children: [] },
    ],
    phases: [],
  });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [
    { path: "goals.0.months.0", key: "import.errors.monthBeforeStart", values: { first: "2026-10" } },
    { path: "goals.0.months.3", key: "import.errors.monthAfterEnd", values: { last: "2026-12-31" } },
    { path: "goals.0.tasks.0", key: "import.errors.monthAfterEnd", values: { last: "2026-12-31" } },
  ]);
});

test("draftRefusals: an amount or an estimate on a goal with no measure", () => {
  const g = goal({
    measure: null,
    months: [{ month: "2026-10", amount: 5 }],
    tasks: [
      { name: "a", month: "2026-10", estimate: 5, children: [{ name: "c", estimate: 1 }, { name: "d", estimate: null }] },
      { name: "b", month: "2026-10", estimate: null, children: [] },
    ],
  });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [
    { path: "goals.0.months.0", key: "import.errors.amountNoMeasure" },
    { path: "goals.0.tasks.0", key: "import.errors.parentWithAmount" },
    { path: "goals.0.tasks.0", key: "month.errors.noMeasure" },
    { path: "goals.0.tasks.0.children.0", key: "month.errors.noMeasure" },
  ]);
});

test("draftRefusals: two amounts for one month name the second", () => {
  const g = goal({ months: [{ month: "2026-10", amount: 1 }, { month: "2026-11", amount: 1 }, { month: "2026-10", amount: 2 }] });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.months.2", key: "import.errors.duplicateMonth" }]);
});

test("draftRefusals: each goal is judged on its own and paths name it", () => {
  const refusals = draftRefusals(draft(goal(), goal({ horizon: "2026-10-01" })), TODAY);
  assert.equal(refusals.every((r) => r.path.startsWith("goals.1.")), true);
  assert.equal(refusals.length > 0, true);
});

const exampleDraft = (): ImportDraftV1 => {
  const example = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8")).template.example;
  const result = parseTemplate(example);
  assert.ok(result.matched && "draft" in result);
  return result.draft;
};

test("draftRefusals: the catalogue's example, a month after October, refuses October's month and both its tasks", () => {
  assert.deepEqual(draftRefusals(exampleDraft(), "2026-11-15"), [
    { path: "goals.0.months.0", key: "import.errors.monthBeforeStart", values: { first: "2026-11" } },
    { path: "goals.0.tasks.0", key: "import.errors.monthBeforeStart", values: { first: "2026-11" } },
    { path: "goals.0.tasks.1", key: "import.errors.monthBeforeStart", values: { first: "2026-11" } },
  ]);
});

test("draftRefusals: the catalogue's example, the day before October ends, refuses nothing", () => {
  assert.deepEqual(draftRefusals(exampleDraft(), "2026-09-30"), []);
});

test("importDraftSchema: a measure unit of 41 characters and an empty one are refused", () => {
  const withUnit = (unit: string) => errorsOf(draft(goal({ measure: { name: "horas", unit } })));
  assert.deepEqual(withUnit("x".repeat(41)), ["plan.errors.unitTooLong"]);
  assert.deepEqual(withUnit("x".repeat(40)), []);
  assert.deepEqual(withUnit("  "), ["plan.errors.unitEmpty"]);
});

test("importDraftSchema: an unknown key inside a measure is refused", () => {
  assert.notDeepEqual(errorsOf(draft(goal({ measure: { name: "horas", unit: "min", extra: 1 } as never }))), []);
});

test("importDraftSchema: issues of a nested phase and commitment carry no goalId segment", () => {
  const paths = (g: ImportDraftV1["goals"][number]) => {
    const parsed = importDraftSchema.safeParse(draft(g));
    return parsed.success ? [] : parsed.error.issues.map((i) => i.path);
  };
  assert.deepEqual(paths(goal({ phases: [{ aim: "x", startsOn: "2026-12-31", endsOn: "2026-10-01" }] })), [
    ["goals", 0, "phases", 0, "endsOn"],
  ]);
  const bad = { name: "x", cadenceKind: "times_per_week" as const, cadenceWeekdays: null, cadenceN: 8, satisfaction: "tap" as const, targetQuantity: null, unit: null };
  assert.deepEqual(paths(goal({ commitments: [bad] })), [["goals", 0, "commitments", 0, "cadenceN"]]);
});

test("draftRefusals: a phase that overlaps and also passes the horizon reports only the horizon", () => {
  const g = goal({
    horizon: "2027-01-01",
    phases: [
      { aim: "a", startsOn: "2026-10-01", endsOn: "2026-12-01" },
      { aim: "b", startsOn: "2026-11-01", endsOn: "2027-02-01" },
    ],
  });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.phases.1", key: "plan.errors.phasePastHorizon" }]);
});

test("draftRefusals: a quantity commitment on a goal with no measure, and a tap, which needs none", () => {
  const quantity = { name: "q", cadenceKind: "daily" as const, cadenceWeekdays: null, cadenceN: null, satisfaction: "quantity" as const, targetQuantity: 5, unit: "min" };
  const tap = { ...quantity, name: "t", satisfaction: "tap" as const, targetQuantity: null, unit: null };
  assert.deepEqual(draftRefusals(draft(goal({ measure: null, months: [], tasks: [], commitments: [tap, quantity] })), TODAY), [
    { path: "goals.0.commitments.1", key: "import.errors.quantityNoMeasure" },
  ]);
  assert.deepEqual(draftRefusals(draft(goal({ commitments: [quantity] })), TODAY), []);
});

test("draftRefusals: a task with sub-tasks and an estimate of its own, at the parent", () => {
  const g = goal({ tasks: [{ name: "Leer", month: "2026-10", estimate: 240, children: [{ name: "Cap. 1", estimate: 60 }] }] });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.tasks.0", key: "import.errors.parentWithAmount" }]);
  const clean = goal({ tasks: [{ name: "Leer", month: "2026-10", estimate: null, children: [{ name: "Cap. 1", estimate: 60 }] }] });
  assert.deepEqual(draftRefusals(draft(clean), TODAY), []);
});

test("draftRefusals: a tap commitment carrying a target or a unit, at the commitment", () => {
  const tap = { name: "Inglés", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "tap" } as const;
  const withTarget = goal({ commitments: [{ ...tap, targetQuantity: 5, unit: null }] });
  const withUnit = goal({ commitments: [{ ...tap, targetQuantity: null, unit: "minutos" }] });
  for (const g of [withTarget, withUnit]) {
    assert.deepEqual(draftRefusals(draft(g), TODAY), [{ path: "goals.0.commitments.0", key: "import.errors.tapWithAmount" }]);
  }
});

test("draftRefusals: a goal ending 2027-03-31 names the months after it with its last day", () => {
  const g = goal({ horizon: "2027-04-01", phases: [], months: [{ month: "2027-04", amount: 1 }, { month: "2027-05", amount: 1 }], tasks: [] });
  assert.deepEqual(draftRefusals(draft(g), TODAY), [
    { path: "goals.0.months.0", key: "import.errors.monthAfterEnd", values: { last: "2027-03-31" } },
    { path: "goals.0.months.1", key: "import.errors.monthAfterEnd", values: { last: "2027-03-31" } },
  ]);
});

const unmeasured = () =>
  goal({
    measure: null,
    months: [],
    commitments: [],
    tasks: [
      { name: "a", month: "2026-10", estimate: 120, children: [{ name: "c", estimate: 60 }] },
      { name: "b", month: "2026-10", estimate: null, children: [] },
    ],
  });

test("strayEstimates and withoutStrayEstimates: only the estimates go, the tasks stay", () => {
  const raw = draft(unmeasured());
  const key = "import.notices.estimateDropped";
  assert.deepEqual(strayEstimates(raw), [
    { path: "goals.0.tasks.0", key },
    { path: "goals.0.tasks.0.children.0", key },
  ]);
  const kept = withoutStrayEstimates(raw);
  const expected = structuredClone(raw);
  expected.goals[0].tasks[0].estimate = null;
  expected.goals[0].tasks[0].children[0].estimate = null;
  assert.deepEqual(kept, expected);
  assert.deepEqual(strayEstimates(kept), []);
  assert.deepEqual(draftRefusals(kept, TODAY), []);
  assert.deepEqual(
    draftRefusals(raw, TODAY).filter((r) => r.key === "month.errors.noMeasure").map((r) => r.path),
    ["goals.0.tasks.0", "goals.0.tasks.0.children.0"],
  );
});

test("strayEstimates: a goal with a measure drops nothing", () => {
  assert.deepEqual(strayEstimates(draft(goal())), []);
});

test("importDraftSchema: a task and a sub-task take a note judged by the note's own rule; a draft with none still passes", () => {
  const task = { name: "T", month: "2026-10", estimate: null, children: [{ name: "c", estimate: 60 }] };
  const parse = (over: object, child: object = {}) =>
    importDraftSchema.safeParse(draft(goal({ tasks: [{ ...task, ...over, children: [{ ...task.children[0], ...child }] }] })));
  assert.equal(parse({}).success, true);
  const ok = parse({ note: "  hola \n" }, { note: "  " });
  assert.ok(ok.success);
  assert.equal(ok.data.goals[0].tasks[0].note, "hola");
  assert.equal(ok.data.goals[0].tasks[0].children[0].note, null);
  const long = parse({}, { note: "x".repeat(2001) });
  assert.ok(!long.success);
  assert.deepEqual(long.error.issues.map((i) => [i.path.join("."), i.message]), [["goals.0.tasks.0.children.0.note", "day.errors.oneOffNoteTooLong"]]);
});

test("importDraftJsonSchema: holds no note key, so the model proposes none", () => {
  assert.equal(JSON.stringify(importDraftJsonSchema).includes('"note"'), false);
});

const phaseOf = (aim: string, startsOn: string, endsOn: string) => ({ aim, startsOn, endsOn });
const OPENS = "2026-10-06";

test("phaseCuts and withCutPhases: a phase that starts before the goal opens begins that day and is listed", () => {
  const raw = draft(goal({ phases: [phaseOf("Evals", "2026-10-01", "2026-12-31")] }));
  assert.deepEqual(phaseCuts(raw, OPENS), [{ path: "goals.0.phases.0", aim: "Evals", from: OPENS }]);
  assert.deepEqual(withCutPhases(raw, OPENS).goals[0].phases, [phaseOf("Evals", OPENS, "2026-12-31")]);
  assert.deepEqual(phaseCuts(withCutPhases(raw, OPENS), OPENS), []);
});

test("phaseCuts and withCutPhases: a phase wholly before the goal opens is dropped and listed", () => {
  const raw = draft(goal({ phases: [phaseOf("Vieja", "2026-08-01", "2026-09-30"), phaseOf("Viva", "2026-10-06", "2026-12-31")] }));
  assert.deepEqual(phaseDrops(raw, OPENS), [{ path: "goals.0.phases.0", aim: "Vieja" }]);
  assert.deepEqual(phaseCuts(raw, OPENS), []);
  assert.deepEqual(withCutPhases(raw, OPENS).goals[0].phases, [phaseOf("Viva", "2026-10-06", "2026-12-31")]);
});

test("phaseCuts: two phases cut in one goal, each listed under its own index", () => {
  const raw = draft(goal({ phases: [phaseOf("A", "2026-09-01", "2026-10-06"), phaseOf("B", "2026-10-01", "2026-12-31")] }));
  assert.deepEqual(phaseCuts(raw, OPENS), [
    { path: "goals.0.phases.0", aim: "A", from: OPENS },
    { path: "goals.0.phases.1", aim: "B", from: OPENS },
  ]);
  assert.deepEqual(withCutPhases(raw, OPENS).goals[0].phases, [phaseOf("A", OPENS, "2026-10-06"), phaseOf("B", OPENS, "2026-12-31")]);
});

test("phaseCuts: a phase starting on the day or later is untouched, and so is the rest of the draft", () => {
  const raw = draft(goal({ phases: [phaseOf("Hoy", OPENS, "2026-11-30"), phaseOf("Luego", "2026-12-01", "2027-01-31")] }));
  assert.deepEqual(phaseCuts(raw, OPENS), []);
  assert.deepEqual(phaseDrops(raw, OPENS), []);
  assert.deepEqual(withCutPhases(raw, OPENS), raw);
});

test("phaseDrops: a phase ending on the day the goal opens is kept, one ending the day before is dropped, and drops are exactly the phases withCutPhases removes", () => {
  const raw = draft(
    goal({
      phases: [
        phaseOf("Ayer", "2026-09-01", "2026-10-05"),
        phaseOf("Hoy", "2026-09-20", OPENS),
        phaseOf("Luego", "2026-10-07", "2026-12-31"),
      ],
    }),
  );
  assert.deepEqual(phaseDrops(raw, OPENS), [{ path: "goals.0.phases.0", aim: "Ayer" }]);
  const kept = withCutPhases(raw, OPENS).goals[0].phases.map((p) => p.aim);
  assert.deepEqual(kept, ["Hoy", "Luego"]);
  const dropped = new Set(phaseDrops(raw, OPENS).map((d) => d.aim));
  assert.deepEqual(
    raw.goals[0].phases.map((p) => p.aim).filter((aim) => !kept.includes(aim)),
    [...dropped],
  );
});

test("inMinutes: a goal measured in hours becomes minutes, figures x60, once", () => {
  const hours = goal({
    measure: { name: "estudio", unit: "horas" },
    months: [{ month: "2026-10", amount: 12 }],
    commitments: [{ name: "Tema", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "quantity", targetQuantity: 2, unit: "horas" }],
    tasks: [{ name: "Leer", month: "2026-10", estimate: 3, children: [{ name: "Cap", estimate: 1 }] }],
  });
  const once = inMinutes(draft(hours));
  const [g] = once.goals;
  assert.equal(g.measure?.unit, "minutos");
  assert.equal(g.months[0].amount, 720);
  assert.equal(g.tasks[0].estimate, 180);
  assert.equal(g.tasks[0].children[0].estimate, 60);
  assert.equal(g.commitments[0].targetQuantity, 120);
  assert.equal(g.commitments[0].unit, "minutos");
  assert.deepEqual(inMinutes(once), once);
  assert.deepEqual(inMinutes(draft(goal())), draft(goal()));
});

test("strayEstimates: a figure in a goal not measured in time is dropped with its own notice", () => {
  const km = goal({
    measure: { name: "distancia", unit: "km" },
    tasks: [{ name: "Correr", month: "2026-10", estimate: 5, children: [] }],
  });
  const raw = draft(km);
  assert.deepEqual(strayEstimates(raw), [{ path: "goals.0.tasks.0", key: "import.notices.estimateDroppedNotTime" }]);
  const kept = withoutStrayEstimates(raw);
  assert.equal(kept.goals[0].tasks.length, 1);
  assert.equal(kept.goals[0].tasks[0].estimate, null);
  assert.deepEqual(strayEstimates(kept), []);
  assert.equal(strayEstimates(draft(unmeasured()))[0].key, "import.notices.estimateDropped");
});

// ---- version 2: normalize, decide, the tree's refusals

const rawTask = (over: Partial<RawTask> = {}): RawTask => ({
  name: "Leer",
  month: "2026-10",
  estimate: null,
  week: null,
  rule: null,
  noteSrc: [],
  noteText: null,
  src: [],
  children: [],
  ...over,
});
const rawGoal = (over: Partial<RawGoal> = {}): RawGoal => ({
  key: "g1",
  parent: null,
  name: "IA aplicada",
  horizon: "2027-10-01",
  measure: { name: "horas", unit: "horas" },
  rate: null,
  noteSrc: [],
  noteText: null,
  src: [],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [],
  ...over,
});
const NO_LINES: Source = { kind: "lines", lines: [] };
const run = (goals: RawGoal[], source: Source = NO_LINES) => normalize({ goals }, source);
const codes = (goals: RawGoal[]) => run(goals).corrections.map((c) => c.code);
const commitment = (over: Record<string, unknown> = {}) => ({
  name: "Correr",
  cadenceKind: "times_per_week" as const,
  cadenceWeekdays: null,
  cadenceN: 3,
  satisfaction: "tap" as const,
  targetQuantity: null,
  unit: null,
  src: [],
  ...over,
});
const tree = (...goals: Partial<DraftGoal>[]): ImportDraft => ({
  version: 2,
  goals: goals.map((over, i) => ({
    key: `g${i + 1}`,
    parent: null,
    name: `Meta ${i + 1}`,
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
  })),
});
const refusalKeys = (draft: ImportDraft) => refusalsOf(draft, TODAY).map((r) => `${r.path} ${r.key}`);

test("v2 schemas: a normalized draft parses, the raw answer parses, the JSON schema is strict", () => {
  const { draft } = run([rawGoal({ tasks: [rawTask({ estimate: 2 })] })]);
  assert.equal(draftV2Schema.safeParse(draft).success, true);
  assert.equal(rawDraftSchema.safeParse({ goals: [rawGoal()] }).success, true);
  assert.equal(draftV2Schema.safeParse({ ...draft, version: 1 }).success, false);
  assert.equal((rawDraftJsonSchema as { additionalProperties?: unknown }).additionalProperties, false);
});

test("three levels: general, large and small pass; a fourth is tooDeep on that goal", () => {
  const three = tree({}, { parent: "g1" }, { parent: "g2" });
  assert.deepEqual(refusalKeys(three), []);
  const four = tree({}, { parent: "g1" }, { parent: "g2" }, { parent: "g3" });
  assert.deepEqual(refusalKeys(four), ["goals.3.parent tree.errors.tooDeep"]);
});

test("a parent that does not exist or comes later is notFound", () => {
  assert.deepEqual(refusalKeys(tree({ parent: "g9" })), ["goals.0.parent tree.errors.notFound"]);
  assert.deepEqual(refusalKeys(tree({ parent: "g2" }, {})), ["goals.0.parent tree.errors.notFound"]);
});

test("a long name ends on a whole word, the whole name opens the note", () => {
  const full = "abcdefgh ".repeat(17).trim();
  const { draft, corrections } = run([rawGoal({ tasks: [rawTask({ name: full })] })]);
  const task = draft.goals[0].tasks[0];
  assert.equal(task.name.length, 116);
  assert.equal(full.startsWith(task.name) && full[task.name.length] === " ", true);
  assert.equal(task.note?.startsWith(full), true);
  const c = corrections.find((x) => x.code === "nameShortened");
  assert.equal(c?.at, "goals.0.tasks.0");
  assert.equal(c?.said, full);
});

test("a goal name and a sub-task name are shortened the same way", () => {
  const full = "abcdefgh ".repeat(17).trim();
  const { draft } = run([rawGoal({ name: full, tasks: [rawTask({ children: [{ name: full, estimate: null, rule: null, noteSrc: [], noteText: null, src: [] }] })] })]);
  assert.equal(draft.goals[0].name.length, 116);
  assert.equal(draft.goals[0].note?.startsWith(full), true);
  assert.equal(draft.goals[0].tasks[0].children[0].name.length, 116);
});

test("a parent's hours equal to its sub-tasks' are dropped", () => {
  const child = (estimate: number) => ({ name: "c", estimate, rule: null, noteSrc: [], noteText: null, src: [] });
  const { draft, corrections } = run([rawGoal({ tasks: [rawTask({ estimate: 9, children: [child(4), child(5)] })] })]);
  assert.equal(draft.goals[0].tasks[0].estimate, null);
  assert.deepEqual(corrections.map((c) => c.code), ["parentEstimateDropped"]);
});

test("a parent's hours that differ from its sub-tasks' say both figures", () => {
  const child = (estimate: number) => ({ name: "c", estimate, rule: null, noteSrc: [], noteText: null, src: [] });
  const { draft, corrections } = run([rawGoal({ tasks: [rawTask({ estimate: 9, children: [child(4), child(3)] })] })]);
  assert.equal(draft.goals[0].tasks[0].estimate, null);
  assert.deepEqual(corrections.map((c) => c.code), ["parentEstimateDiffers"]);
  assert.equal(corrections[0].values?.parent, "9");
  assert.equal(corrections[0].values?.children, "7");
});

test("a cadence outside RP-12 goes to its ceiling", () => {
  const goal = (c: Record<string, unknown>) => rawGoal({ commitments: [commitment(c)] });
  const week = run([goal({ cadenceN: 9 })]);
  assert.equal(week.draft.goals[0].commitments[0].cadenceN, 7);
  assert.deepEqual(week.corrections.map((c) => c.code), ["cadenceClamped"]);
  assert.equal(run([goal({ cadenceKind: "times_per_month", cadenceN: 40 })]).draft.goals[0].commitments[0].cadenceN, 31);
  assert.equal(run([goal({ cadenceKind: "every_n_days", cadenceN: 400 })]).draft.goals[0].commitments[0].cadenceN, 365);
  assert.deepEqual(codes([goal({ cadenceN: 7 })]), []);
});

test("a weekly rate becomes a monthly rhythm in whole minutes, 52 weeks over 12 months", () => {
  const { draft, corrections } = run([rawGoal({ rate: { amount: 10, unit: "hours", per: "week" } })]);
  assert.equal(draft.goals[0].rhythm, 2600);
  assert.equal(corrections[0].code, "rateToRhythm");
  assert.equal(corrections[0].said, "10 h por semana");
  assert.equal(run([rawGoal({ rate: { amount: 7, unit: "hours", per: "week" } })]).draft.goals[0].rhythm, 1820);
  const monthly = run([rawGoal({ rate: { amount: 30, unit: "hours", per: "month" } })]);
  assert.equal(monthly.draft.goals[0].rhythm, 1800);
  assert.deepEqual(monthly.corrections, []);
});

test("a goal with goals inside moves its rhythm and its month amounts to its note", () => {
  const { draft, corrections } = run([
    rawGoal({ rate: { amount: 10, unit: "hours", per: "week" }, months: [{ month: "2026-10", amount: 20, src: [] }, { month: "2026-11", amount: 10, src: [] }] }),
    rawGoal({ key: "g2", parent: "g1" }),
  ]);
  const general = draft.goals[0];
  assert.equal(general.rhythm, null);
  assert.deepEqual(general.months, []);
  assert.deepEqual(corrections.map((c) => c.code), ["holderRhythmToNote", "holderMonthsToNote"]);
  assert.equal(general.note?.includes("2600"), true);
  assert.equal(general.note?.includes("2026-10"), true);
  assert.equal(general.note?.includes("1200"), true);
});

test("a child ending after the goal above ends with it; declined, it stays and is refused", () => {
  const { draft, corrections } = run([rawGoal({ horizon: "2027-06-01" }), rawGoal({ key: "g2", parent: "g1", horizon: "2027-10-01" })]);
  assert.equal(draft.goals[1].horizon, "2027-06-01");
  assert.deepEqual(corrections.map((c) => c.code), ["endWithinAbove"]);
  assert.deepEqual(refusalKeys(draft), []);
  const back = decide(draft, corrections, new Set([corrections[0].id]));
  assert.equal(back.goals[1].horizon, "2027-10-01");
  assert.deepEqual(refusalKeys(back), ["goals.1.horizon tree.errors.endPastAbove"]);
});

test("a plan counting hours with no measure is measured in hours, kept in minutes", () => {
  const { draft, corrections } = run([
    rawGoal({ measure: null, months: [{ month: "2026-10", amount: 10, src: [] }], tasks: [rawTask({ estimate: 2 })] }),
  ]);
  assert.deepEqual(draft.goals[0].measure, { name: "horas", unit: "minutos" });
  assert.equal(draft.goals[0].months[0].amount, 600);
  assert.equal(draft.goals[0].tasks[0].estimate, 120);
  assert.deepEqual(corrections.map((c) => c.code), ["measureInHours"]);
  const named = run([rawGoal({ months: [{ month: "2026-10", amount: 10, src: [] }] })]);
  assert.equal(named.draft.goals[0].months[0].amount, 600);
  assert.deepEqual(named.corrections, []);
});

test("the note is the source's own lines, never the answer's text", () => {
  const lines = ["l1", "l2", "l3", "l4", "l5", "l6"];
  const { draft } = run(
    [rawGoal({ noteSrc: [{ from: 3, to: 5 }], noteText: "inventado", tasks: [rawTask({ noteSrc: [{ from: 1, to: 2 }], noteText: "otro" })] })],
    { kind: "lines", lines },
  );
  assert.equal(draft.goals[0].note, "l3\nl4\nl5");
  assert.equal(draft.goals[0].tasks[0].note, "l1\nl2");
});

test("from parts the note is the answer's text", () => {
  const { draft } = run([rawGoal({ noteText: "texto del modelo" })], { kind: "parts", lines: null });
  assert.equal(draft.goals[0].note, "texto del modelo");
  assert.equal(run([rawGoal({ noteText: "x" })], { kind: "rows", lines: ["a"] }).draft.goals[0].note, null);
});

test("a note over its ceiling keeps whole lines up to it, never more", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${"x".repeat(98)}${String(i).padStart(2, "0")}`);
  const { draft } = run([rawGoal({ tasks: [rawTask({ noteSrc: [{ from: 1, to: 30 }] })] })], { kind: "lines", lines });
  const note = draft.goals[0].tasks[0].note ?? "";
  assert.equal(note.length <= 2000, true);
  assert.equal(note, lines.slice(0, 19).join("\n"));
});

test("a rejected nameShortened leaves the part out: the full name is back and refused", () => {
  const full = "abcdefgh ".repeat(17).trim();
  const { draft, corrections } = run([rawGoal({ tasks: [rawTask({ name: full })] })]);
  const back = decide(draft, corrections, new Set([corrections[0].id]));
  assert.equal(back.goals[0].tasks[0].name, full);
  assert.equal(back.goals[0].tasks[0].note, null);
  assert.deepEqual(refusalKeys(back), ["goals.0.tasks.0 day.errors.oneOffNameTooLong"]);
  assert.deepEqual(refusalKeys(decide(draft, corrections, new Set())), []);
});

test("decide undoes each normalize correction it is told to decline", () => {
  const child = (estimate: number) => ({ name: "c", estimate, rule: null, noteSrc: [], noteText: null, src: [] });
  const { draft, corrections } = run([
    rawGoal({
      rate: { amount: 10, unit: "hours", per: "week" },
      commitments: [commitment({ cadenceN: 9 })],
      tasks: [rawTask({ estimate: 9, children: [child(4), child(3)] })],
    }),
    rawGoal({ key: "g2", parent: "g1" }),
  ]);
  const all = decide(draft, corrections, new Set(corrections.map((c) => c.id)));
  assert.equal(all.goals[0].commitments[0].cadenceN, 9);
  assert.equal(all.goals[0].tasks[0].estimate, 540);
  assert.equal(all.goals[0].rhythm, 2600);
  assert.equal(all.goals[0].note, null);
  assert.deepEqual(refusalKeys(all).sort(), [
    "goals.0.commitments.0 plan.errors.timesPerWeekInvalid",
    "goals.0.rhythm tree.errors.holderNoRhythm",
    "goals.0.tasks.0 import.errors.parentWithAmount",
  ]);
});
