import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { IntlMessageFormat } from "intl-messageformat";

import { changesAnything, differences, fingerprint, matchGoals, type Difference, type GoalSnapshot } from "./differences";
import type { ImportDraftV1 } from "./draft";

type DraftGoal = ImportDraftV1["goals"][number];

const TODAY = "2026-10-15";
const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));

const draftGoal = (over: Partial<DraftGoal> = {}): DraftGoal => ({
  name: "Inglés",
  rhythm: null,
  horizon: null,
  measure: null,
  phases: [],
  months: [],
  commitments: [],
  tasks: [],
  ...over,
});

const snapshot = (over: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  id: "g1",
  name: "Inglés",
  horizon: "2027-10-01",
  note: null,
  measure: { name: "Horas", unit: "h" },
  measureFed: false,
  rhythm: 600,
  months: [{ month: "2026-10-01", amount: 600 }],
  phases: [{ id: "p1", aim: "Base", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
  commitments: [
    {
      id: "c1",
      name: "Leer",
      cadence: { kind: "daily", weekdays: null, n: null },
      satisfaction: "tap",
      target: null,
      unit: null,
      hasFacts: false,
    },
  ],
  tasks: [{ id: "t1", name: "Curso", estimate: 60, month: "2026-10-01", done: false, children: [] }],
  ...over,
});

const commitment = (over: Partial<DraftGoal["commitments"][number]> = {}): DraftGoal["commitments"][number] => ({
  name: "Leer",
  cadenceKind: "daily",
  cadenceWeekdays: null,
  cadenceN: null,
  satisfaction: "tap",
  targetQuantity: null,
  unit: null,
  ...over,
});

const task = (over: Partial<DraftGoal["tasks"][number]> = {}): DraftGoal["tasks"][number] => ({
  name: "Curso",
  month: "2026-10",
  estimate: 60,
  children: [],
  ...over,
});

// The changes alone: a fixture that names one kind of part leaves the rest to `stays`.
const changes = (goal: DraftGoal, from: GoalSnapshot) =>
  differences(goal, from, TODAY).filter((d) => d.kind !== "stays");

const draftOf = (...names: string[]): ImportDraftV1 => ({ goals: names.map((name) => draftGoal({ name })) });
const shot = (id: string, name: string) => snapshot({ id, name });

test("an open name matches across case and spacing, not across accents", () => {
  assert.equal((matchGoals(draftOf("Inglés "), [shot("a", "inglés")])[0].match as GoalSnapshot).id, "a");
  assert.equal(matchGoals(draftOf("Ingles"), [shot("a", "Inglés")])[0].match, null);
});

test("two open goals of a name are ambiguous, not a pick", () => {
  const out = matchGoals(draftOf("Leer", "Otra"), [shot("a", "Leer"), shot("b", "leer")]);
  assert.deepEqual(out.map((m) => m.match), ["ambiguous", null]);
  assert.deepEqual(out.map((m) => m.g), [0, 1]);
});

test("a goal like its snapshot differs in nothing", () => {
  const same = draftGoal({
    horizon: "2027-10-01",
    measure: { name: "Horas", unit: "h" },
    rhythm: 600,
    months: [{ month: "2026-10", amount: 600 }],
    phases: [{ aim: "Base", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
    commitments: [commitment()],
    tasks: [task()],
  });
  const list = differences(same, snapshot(), TODAY);
  assert.deepEqual(list, []);
  assert.equal(changesAnything(list), false);
});

test("horizon, note, rhythm, measure", () => {
  const goal = { ...draftGoal({ horizon: "2028-01-01", rhythm: 900, measure: { name: "Páginas", unit: "pág" } }), note: "nueva" };
  assert.deepEqual(changes(goal, snapshot()), [
    { kind: "horizon", to: "2028-01-01" },
    { kind: "note", to: "nueva" },
    { kind: "measure", name: "Páginas", unit: "pág", kept: null },
    { kind: "rhythm", to: 900 },
  ]);
});

test("a fed measure is kept", () => {
  const goal = draftGoal({ measure: { name: "Páginas", unit: "pág" } });
  assert.deepEqual(changes(goal, snapshot({ measureFed: true })), [
    { kind: "measure", name: "Páginas", unit: "pág", kept: "fed" },
  ]);
});

test("only open months differ", () => {
  const goal = draftGoal({
    months: [
      { month: "2026-09", amount: 5 },
      { month: "2026-10", amount: 700 },
      { month: "2026-11", amount: 800 },
    ],
  });
  assert.deepEqual(changes(goal, snapshot()), [
    { kind: "month", month: "2026-10", amount: 700 },
    { kind: "month", month: "2026-11", amount: 800 },
  ]);
});

test("a phase is added, or moved when the aim is the same", () => {
  const goal = draftGoal({
    phases: [
      { aim: "base", startsOn: "2026-10-01", endsOn: "2026-11-30" },
      { aim: "Fluidez", startsOn: "2027-01-01", endsOn: "2027-03-31" },
    ],
  });
  assert.deepEqual(changes(goal, snapshot()), [
    { kind: "phaseChanged", aim: "base", startsOn: "2026-10-01", endsOn: "2026-11-30" },
    { kind: "phaseAdded", aim: "Fluidez", startsOn: "2027-01-01", endsOn: "2027-03-31" },
  ]);
});

test("a commitment is added, changed, or replaced when it has facts", () => {
  const weekly = commitment({ cadenceKind: "times_per_week", cadenceN: 3 });
  const goal = draftGoal({ commitments: [weekly, commitment({ name: "Escribir" })] });
  assert.deepEqual(changes(goal, snapshot()), [
    { kind: "commitmentChanged", name: "Leer" },
    { kind: "commitmentAdded", name: "Escribir" },
  ]);
  const withFacts = snapshot();
  withFacts.commitments[0].hasFacts = true;
  assert.deepEqual(changes(draftGoal({ commitments: [weekly] }), withFacts), [
    { kind: "commitmentReplaced", name: "Leer" },
  ]);
});

test("a task is added, changed in estimate or month, with sub-tasks added", () => {
  const goal = draftGoal({
    tasks: [
      task({ estimate: 90, children: [{ name: "Unidad 1", estimate: 30 }] }),
      task({ name: "Examen", month: "2026-11" }),
    ],
  });
  assert.deepEqual(changes(goal, snapshot()), [
    { kind: "taskResized", name: "Curso", from: 60, to: 90 },
    { kind: "subTaskAdded", name: "Unidad 1", task: "Curso" },
    { kind: "taskAdded", name: "Examen" },
  ]);
  assert.deepEqual(changes(draftGoal({ tasks: [task({ month: "2026-12" })] }), snapshot()), [
    { kind: "taskMoved", name: "Curso", from: "2026-10", to: "2026-12" },
  ]);
});

test("a task's change says what moves: its month, its estimate, or both", () => {
  const both = draftGoal({ tasks: [task({ month: "2026-11", estimate: null })] });
  assert.deepEqual(changes(both, snapshot()), [
    { kind: "taskMoved", name: "Curso", from: "2026-10", to: "2026-11" },
    { kind: "taskResized", name: "Curso", from: 60, to: null },
  ]);
  const none = snapshot();
  none.tasks[0].estimate = null;
  assert.deepEqual(changes(draftGoal({ tasks: [task({ estimate: 45 })] }), none), [
    { kind: "taskResized", name: "Curso", from: null, to: 45 },
  ]);
});

test("a phase of another name whose dates cross an existing one is no addition; the day after is no crossing", () => {
  const crossing = draftGoal({ phases: [{ aim: "Base suave", startsOn: "2026-12-31", endsOn: "2027-02-28" }] });
  assert.deepEqual(changes(crossing, snapshot()), [
    { kind: "phaseOverlaps", aim: "Base suave", startsOn: "2026-12-31", endsOn: "2027-02-28", with: "Base" },
  ]);
  assert.equal(changesAnything(changes(crossing, snapshot())), false);
  const after = draftGoal({ phases: [{ aim: "Base suave", startsOn: "2027-01-01", endsOn: "2027-02-28" }] });
  assert.deepEqual(changes(after, snapshot()), [
    { kind: "phaseAdded", aim: "Base suave", startsOn: "2027-01-01", endsOn: "2027-02-28" },
  ]);
});

test("a phase shares a calendar week with another when their dates do not meet", () => {
  // 2026-12-31 is a Thursday: both phases fall in the week of Monday 28 December.
  const week = snapshot({ phases: [{ id: "p1", aim: "Base", startsOn: "2026-10-01", endsOn: "2026-12-30" }] });
  const goal = draftGoal({ phases: [{ aim: "Velocidad", startsOn: "2026-12-31", endsOn: "2027-02-28" }] });
  assert.deepEqual(changes(goal, week).map((d) => d.kind), ["phaseAdded"]);
});

test("a phase the plan renames across its old dates is judged against the phases the plan does not name", () => {
  const goal = draftGoal({
    phases: [
      { aim: "Base", startsOn: "2027-01-01", endsOn: "2027-02-28" },
      { aim: "Otra", startsOn: "2026-10-16", endsOn: "2026-12-31" },
    ],
  });
  assert.deepEqual(changes(goal, snapshot()).map((d) => d.kind), ["phaseChanged", "phaseAdded"]);
});

test("a phase moved onto another existing one crosses it", () => {
  const two = snapshot({
    phases: [
      { id: "p1", aim: "Base", startsOn: "2026-10-01", endsOn: "2026-11-30" },
      { id: "p2", aim: "Velocidad", startsOn: "2026-12-01", endsOn: "2027-02-28" },
    ],
  });
  const goal = draftGoal({ phases: [{ aim: "Base", startsOn: "2026-10-01", endsOn: "2026-12-10" }] });
  assert.deepEqual(changes(goal, two), [
    { kind: "phaseOverlaps", aim: "Base", startsOn: "2026-10-01", endsOn: "2026-12-10", with: "Velocidad" },
  ]);
});

test("a done task is left alone", () => {
  const done = snapshot();
  done.tasks[0].done = true;
  const left: Difference[] = [
    { kind: "stays", part: "phase", name: "Base" },
    { kind: "stays", part: "commitment", name: "Leer" },
  ];
  assert.deepEqual(differences(draftGoal({ tasks: [task({ estimate: 999 })] }), done, TODAY), left);
  assert.deepEqual(differences(draftGoal({ tasks: [task({ month: "2026-12" })] }), done, TODAY), left);
});

test("a part the plan omits stays by name, and stays alone changes nothing", () => {
  const list = differences(draftGoal(), snapshot(), TODAY);
  assert.deepEqual(list, [
    { kind: "stays", part: "phase", name: "Base" },
    { kind: "stays", part: "commitment", name: "Leer" },
    { kind: "stays", part: "task", name: "Curso" },
  ]);
  assert.equal(changesAnything(list), false);
});

test("no difference removes a part", () => {
  const kinds = differences(draftGoal(), snapshot(), TODAY).map((d) => d.kind);
  assert.ok(kinds.every((k) => !/remov|delet|drop|retire/i.test(k)));
});

test("the fingerprint ignores order and follows content", () => {
  const a: Difference = { kind: "month", month: "2026-10", amount: 1 };
  const b: Difference = { kind: "taskAdded", name: "X" };
  assert.equal(fingerprint([a, b]), fingerprint([b, a]));
  assert.notEqual(fingerprint([a]), fingerprint([{ ...a, amount: 2 }]));
  assert.equal(fingerprint([]), "");
});

test("the new messages parse and the plural formats", () => {
  const say = (path: string[], values: Record<string, string | number>) => {
    const leaf = path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], catalogue);
    assert.equal(typeof leaf, "string", `${path.join(".")} is no message`);
    return String(new IntlMessageFormat(leaf as string, "es").format(values));
  };
  assert.equal(say(["created", "updated"], { count: 1 }), "1 meta actualizada");
  assert.equal(say(["created", "updated"], { count: 3 }), "3 metas actualizadas");
  assert.equal(say(["review", "update"], { goal: "Inglés" }), "Actualiza tu meta «Inglés»");
  assert.equal(say(["review", "diff", "stays"], { part: "phase", name: "Base" }), "Se queda la fase «Base», que el plan no nombra");
  assert.match(say(["review", "diff", "stays"], { part: "task", name: "Curso" }), /la tarea «Curso»/);
  assert.equal(
    say(["review", "diff", "taskMoved"], { name: "Carrera de prueba", from: "Octubre", to: "Noviembre" }),
    "Pasa la tarea «Carrera de prueba» de Octubre a Noviembre",
  );
  assert.match(say(["review", "diff", "taskResized"], { name: "T", shape: "change", from: "1 h", to: "2 h" }), /de 1 h a 2 h/);
  assert.match(say(["review", "diff", "taskResized"], { name: "T", shape: "set", from: "", to: "2 h" }), /Le pone 2 h/);
  assert.match(say(["review", "diff", "taskResized"], { name: "T", shape: "drop", from: "1 h", to: "" }), /Quita el estimado/);
  assert.match(
    say(["review", "diff", "phaseOverlaps"], { aim: "Base aeróbica", startsOn: "15 oct", endsOn: "30 nov", with: "Base aeróbica suave" }),
    /se cruza con «Base aeróbica suave»/,
  );
  for (const key of Object.keys(catalogue.review.diff)) {
    const leaf = catalogue.review.diff[key] as string;
    assert.doesNotThrow(() => new IntlMessageFormat(leaf, "es"), key);
  }
  assert.ok(catalogue.review.noChange && catalogue.errors.reviewStale);
});
