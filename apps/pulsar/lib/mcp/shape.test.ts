import assert from "node:assert/strict";
import test from "node:test";

import type { Report } from "@/lib/export/report";
import type { Task } from "@/lib/plan/carry";
import type { loadDay } from "@/lib/queries/day";
import type { GoalView } from "@/lib/queries/goal";
import { fillPlan, type PlanInput, type PlanTask } from "@/lib/plan/roadmap";
import { planMonthList } from "@/lib/plan/roadmap-read";

import { amountOf, shapeDay, shapeGoal, shapeGoalList, shapeLoose, shapeMonth, shapeReport } from "./shape";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const tasks: Task[] = [
  { id: ID(1), parentId: null, name: "Capítulo 1", plannedMonth: "2026-09-01", day: null, estimate: 300, doneOn: null },
  { id: ID(2), parentId: null, name: "Capítulo 0", plannedMonth: "2026-09-01", day: null, estimate: 300, doneOn: "2026-09-10" },
  { id: ID(3), parentId: null, name: "Parte 2", plannedMonth: "2026-10-01", day: null, estimate: null, doneOn: null },
  { id: ID(4), parentId: ID(3), name: "Leer", plannedMonth: null, day: null, estimate: 200, doneOn: "2026-10-03", note: "Hasta la página 40" },
  { id: ID(5), parentId: ID(3), name: "Resumir", plannedMonth: null, day: null, estimate: 100, doneOn: null },
];

const planned = (list: Task[]): PlanTask[] =>
  list.map((task, position) => ({ ...task, inPlan: false, position, createdOn: "2026-08-15" }));

const planOf = (list: PlanTask[]): PlanInput => ({
  rhythm: 600,
  budgets: [],
  tasks: list,
  openedOn: "2026-08-15",
  horizon: "2027-01-01",
  today: "2026-10-05",
});

function goalView(unit: string | null): GoalView {
  const plan = planOf(planned(tasks));
  return {
    id: ID(10),
    name: "Leer más",
    horizon: "2027-01-01",
    endedOn: null,
    createdAt: "2026-08-15T15:00:00.000Z",
    measureName: unit === null ? null : "Lectura",
    measureUnit: unit,
    archivedAt: null,
    measureTotal: 570,
    phases: [{ id: ID(11), name: "Arranque", startsOn: "2026-08-17", endsOn: "2026-09-27" }],
    commitments: [
      {
        id: ID(12),
        name: "Leer 30 min",
        cadence: { kind: "weekdays", days: [1, 3, 5] },
        satisfiedBy: { kind: "quantity", target: 30, unit: unit ?? "minutos" },
        retiredAt: null,
        sourceLabelKey: null,
        factDayCount: 4,
      },
      {
        id: ID(13),
        name: "Leer en la app",
        cadence: { kind: "daily" },
        satisfiedBy: { kind: "evidence", threshold: 10, unit: "páginas" },
        retiredAt: "2026-10-01",
        sourceLabelKey: "sources.readingLookups",
        factDayCount: 0,
      },
      {
        id: ID(14),
        name: "Repasar",
        cadence: { kind: "daily" },
        satisfiedBy: { kind: "tap" },
        retiredAt: null,
        sourceLabelKey: null,
        factDayCount: 1,
      },
    ],
    weeks: [{ index: 8, startsOn: "2026-10-05", endsOn: "2026-10-11", total: 750, phaseName: "Arranque", current: true }],
    evidence: "unreadable",
    month: { month: "2026-10-01", planned: 750, reached: 120, underPace: false },
    months: [
      { month: "2026-09-01", planned: 600, reached: 450, current: false, past: true },
      { month: "2026-10-01", planned: 750, reached: 120, current: true, past: false },
      { month: "2026-11-01", planned: null, reached: 0, current: false, past: false },
    ],
    budgets: [],
    tasks: planned(tasks),
    rhythm: 600,
    planSeen: null,
    plan,
    roadmap: fillPlan(plan),
    note: null,
    parent: null,
    ancestors: [],
    level: null,
    holdsGoals: false,
    children: [],
    outOfUnit: [],
    branchOpenCount: 0,
    latestBelow: null,
    above: null,
    tree: [],
  };
}

// Every string a field that names a month holds, wherever it sits.
function monthsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => monthsIn(v, found));
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (["month", "from", "carriedFrom"].includes(key) && typeof inner === "string") found.push(inner);
      else monthsIn(inner, found);
    }
  }
  return found;
}

function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === "number") found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, found));
  else if (typeof value === "object" && value !== null) Object.values(value).forEach((v) => numbersIn(v, found));
  return found;
}

test("a goal's months read YYYY-MM, never the first of the month", () => {
  const shaped = shapeGoal(goalView("minutos"));
  assert.deepEqual(
    shaped.months.map((m) => m.month),
    ["2026-09", "2026-10", "2026-11"],
  );
  assert.equal(shaped.thisMonth?.month, "2026-10");
  const months = monthsIn(shaped);
  assert.ok(months.length >= 6);
  for (const month of months) assert.match(month, /^\d{4}-\d{2}$/);
});

test("750 minutes is an amount with its words; another unit has no text", () => {
  const minutes = shapeGoal(goalView("minutos"));
  assert.deepEqual(minutes.months[1].planned, { value: 750, unit: "minutos", text: "12 h 30 min" });
  assert.deepEqual(amountOf(60, "min"), { value: 60, unit: "min", text: "1 h" });
  const pages = shapeGoal(goalView("páginas"));
  assert.deepEqual(pages.months[1].planned, { value: 750, unit: "páginas" });
  assert.equal("text" in (pages.months[1].planned as object), false);
  assert.equal("text" in (pages.measureTotal as object), false);
});

test("a goal that measures nothing has a unit of null and no text", () => {
  assert.deepEqual(amountOf(5, null), { value: 5, unit: null });
  const shaped = shapeGoal(goalView(null));
  assert.equal(shaped.measure, null);
  assert.equal(shaped.measureTotal, null);
});

test("an amount is an integer: a float is refused and none leaves a shape", () => {
  assert.throws(() => amountOf(1.5, "páginas"));
  for (const unit of ["minutos", "páginas", null]) {
    for (const n of numbersIn(shapeGoal(goalView(unit)))) assert.ok(Number.isInteger(n), String(n));
  }
});

test("a finished month's carried share is what its undone tasks left, floored", () => {
  const [september, october] = shapeGoal(goalView("minutos")).months;
  assert.deepEqual(september.carried, { value: 300, unit: "minutos", text: "5 h" });
  assert.equal(september.carriedPercent, 50);
  assert.equal(october.carried, null);
  assert.equal(october.carriedPercent, null);
});

test("a share floors: 2 carried of 3 planned is 66, never rounded to 67", () => {
  const view = goalView("minutos");
  view.months = [{ month: "2026-08-01", planned: 3, reached: 1, current: false, past: true }];
  view.tasks = planned([
    { id: ID(40), parentId: null, name: "a", plannedMonth: "2026-08-01", day: null, estimate: 1, doneOn: "2026-08-20" },
    { id: ID(41), parentId: null, name: "b", plannedMonth: "2026-08-01", day: null, estimate: 1, doneOn: null },
    { id: ID(42), parentId: null, name: "c", plannedMonth: "2026-08-01", day: null, estimate: 1, doneOn: null },
  ]);
  view.tasks = view.tasks.map((task) => ({ ...task, createdOn: "2026-08-01" }));
  view.plan = planOf(view.tasks);
  const [august] = shapeGoal(view).months;
  assert.equal(august.carried?.value, 2);
  assert.equal(august.carriedPercent, 66);
});

test("tasks are a tree: a sub-task sits under its parent and takes its month", () => {
  const tree = shapeGoal(goalView("minutos")).tasks;
  assert.deepEqual(
    tree.map((t) => t.name),
    ["Capítulo 1", "Capítulo 0", "Parte 2"],
  );
  const parent = tree[2];
  assert.equal(parent.month, "2026-10");
  assert.deepEqual(
    parent.children.map((c) => [c.name, c.month, c.doneOn, c.estimate?.value]),
    [
      ["Leer", "2026-10", "2026-10-03", 200],
      ["Resumir", "2026-10", null, 100],
    ],
  );
  assert.equal(tree[1].doneOn, "2026-09-10");
  assert.equal(parent.estimate, null);
  assert.deepEqual(parent.children.map((c) => c.note), ["Hasta la página 40", null]);
});

test("commitments keep cadence, retirement and what satisfies them; evidence is named", () => {
  const shaped = shapeGoal(goalView("minutos"));
  const [quantity, evidence, tap] = shaped.commitments;
  assert.deepEqual(quantity.cadence, { kind: "weekdays", days: [1, 3, 5] });
  assert.deepEqual(quantity.satisfiedBy, { kind: "quantity", target: { value: 30, unit: "minutos", text: "30 min" } });
  assert.equal(evidence.retiredAt, "2026-10-01");
  assert.deepEqual(evidence.satisfiedBy.target, { value: 10, unit: "páginas" });
  assert.equal(evidence.evidenceSource, "sources.readingLookups");
  assert.equal(tap.satisfiedBy.target, null);
  assert.equal(shaped.evidence, "unreadable");
  assert.equal(shaped.openedOn, "2026-08-15");
});

test("a shape is plain JSON: nothing is lost or made up by a round trip", () => {
  const shaped = shapeGoal(goalView("minutos"));
  assert.deepEqual(JSON.parse(JSON.stringify(shaped)), shaped);
});

test("a month's list carries the carried tasks first, each with its part, its fixing and its neighbours", () => {
  const input = planOf(planned(tasks));
  const items = planMonthList(input, "2026-10-01");
  const shaped = shapeMonth({ goalId: ID(10), month: "2026-10-01", unit: "minutos", items });
  assert.equal(shaped.month, "2026-10");
  assert.deepEqual(
    shaped.items.map((i) => [i.name, i.carriedFrom, i.part.value, i.fixed, i.done]),
    [
      ["Capítulo 1", "2026-09", 300, true, false],
      ["Parte 2", null, 100, true, false],
    ],
  );
  assert.deepEqual(shaped.items[0].part, { value: 300, unit: "minutos", text: "5 h" });
  assert.equal(shaped.items[1].children.length, 2);
  for (const month of monthsIn(shaped)) assert.match(month, /^\d{4}-\d{2}$/);
});

test("a split task reads its part, and where the rest sits, as YYYY-MM", () => {
  const big: Task = { id: ID(50), parentId: null, name: "Tesis", plannedMonth: null, day: null, estimate: 900, doneOn: null };
  const input = planOf(planned([big]).map((task) => ({ ...task, inPlan: true })));
  const october = shapeMonth({ goalId: ID(10), month: "2026-10-01", unit: "minutos", items: planMonthList(input, "2026-10-01") });
  const november = shapeMonth({ goalId: ID(10), month: "2026-11-01", unit: "minutos", items: planMonthList(input, "2026-11-01") });
  assert.deepEqual([october.items[0].part.value, october.items[0].from, october.items[0].to, october.items[0].fixed], [600, null, "2026-11", false]);
  assert.deepEqual([november.items[0].part.value, november.items[0].from, november.items[0].to], [300, "2026-10", null]);
});

test("a goal reads its rhythm, the plan's end and each task's month: fixed, or its first part's", () => {
  const view = goalView("minutos");
  const free: PlanTask = { id: ID(51), parentId: null, name: "Libre", plannedMonth: null, day: null, estimate: 700, doneOn: null, inPlan: true, createdOn: "2026-08-15", position: 9 };
  view.tasks = [...view.tasks, free];
  view.plan = planOf(view.tasks);
  view.roadmap = fillPlan(view.plan);
  const shaped = shapeGoal(view);
  assert.deepEqual(shaped.rhythm, { value: 600, unit: "minutos", text: "10 h" });
  assert.match(shaped.end ?? "", /^\d{4}-\d{2}-\d{2}$/);
  const byName = new Map(shaped.tasks.map((task) => [task.name, task]));
  assert.deepEqual([byName.get("Libre")?.month, byName.get("Libre")?.fixed], ["2026-11", false]);
  assert.deepEqual([byName.get("Capítulo 1")?.month, byName.get("Capítulo 1")?.fixed], ["2026-10", true]);
  assert.equal(byName.get("Parte 2")?.children[0].fixed, true);
});

test("the goal list keeps its three groups and each goal's measure", () => {
  const summary = (n: number, unit: string | null, archivedAt: string | null) => ({
    id: ID(n),
    name: `Meta ${n}`,
    horizon: "2027-01-01",
    measureName: unit === null ? null : "Lectura",
    measureUnit: unit,
    archivedAt,
    parentId: n === 2 ? ID(1) : null,
    level: null,
  });
  const shaped = shapeGoalList({
    open: [summary(1, "páginas", null)],
    ended: [summary(2, null, null)],
    archived: [summary(3, "minutos", "2026-09-01T10:00:00Z")],
  });
  assert.deepEqual(shaped.open[0], {
    id: ID(1),
    name: "Meta 1",
    horizon: "2027-01-01",
    measure: { name: "Lectura", unit: "páginas" },
    archivedAt: null,
    parentId: null,
    level: null,
    childIds: [ID(2)],
  });
  assert.equal(shaped.ended[0].measure, null);
  assert.equal(shaped.archived[0].archivedAt, "2026-09-01T10:00:00Z");
});

test("a goal reads the goal above, the goals below, its level and its note", () => {
  const view: GoalView = {
    ...goalView("minutos"),
    note: "una\ndos",
    parent: { id: ID(20), name: "Arriba", horizon: "2027-06-01" },
    level: "large",
    holdsGoals: true,
    rhythm: null,
    children: [
      {
        id: ID(21),
        name: "Abajo",
        level: "small",
        unit: "minutos",
        inUnit: true,
        month: { planned: 90, reached: 30 },
        endedOn: null,
        archivedAt: null,
      },
    ],
    outOfUnit: [{ id: ID(22), name: "Otra", unit: "páginas" }],
  };
  const shaped = shapeGoal(view);
  assert.deepEqual(shaped.parent, { id: ID(20), name: "Arriba" });
  assert.equal(shaped.children[0].name, "Abajo");
  assert.equal(shaped.children[0].thisMonth?.planned?.value, 90);
  assert.deepEqual([shaped.level, shaped.holdsGoals, shaped.rhythm, shaped.note], ["large", true, null, "una\ndos"]);
  assert.deepEqual(shaped.outOfUnit, [{ id: ID(22), name: "Otra", unit: "páginas" }]);
});

type LoadedDay = Awaited<ReturnType<typeof loadDay>>;

test("a day pairs each slot with its commitment, its unit and its amounts", () => {
  const loaded: LoadedDay = {
    view: {
      day: "2026-10-05",
      slots: [
        { commitmentId: ID(12), satisfied: true, satisfiedBy: "declared", labelKey: null, quantity: 45, partial: false },
        { commitmentId: ID(14), satisfied: false, satisfiedBy: null, labelKey: null, quantity: null, partial: false },
      ],
      phase: { id: ID(11), name: "Arranque", startsOn: "2026-08-17", endsOn: "2026-09-27" },
    },
    evidence: "unreadable",
    goals: [
      { id: ID(10), name: "Leer más", horizon: "2027-01-01", openedOn: "2026-08-15", measureName: "Lectura", measureUnit: "minutos", parentId: null, level: null, rootId: ID(10) },
    ],
    groups: [{ rootId: ID(10), goalIds: [ID(10)] }],
    oneOffs: [
      { id: ID(20), goalId: ID(10), name: "Pedir el libro", note: "Pedir en la biblioteca\nantes del viernes", day: "2026-10-03" },
      { id: ID(21), goalId: null, name: "Llamar", note: null, day: "2026-10-05" },
    ],
    doneOneOffs: [{ id: ID(22), goalId: null, name: "Pagar", note: "Con la tarjeta", factId: ID(23), writtenAt: "2026-10-05T14:00:00Z" }],
    daylessCount: 2,
    scheduledCount: 1,
    lastEnded: null,
    endedThisWeek: [],
    weekMeasure: { [ID(10)]: 90 },
    monthLine: { [ID(10)]: { planned: 750, reached: 120, underPace: false, ownBudget: false } },
    commitments: [
      { id: ID(12), goalId: ID(10), name: "Leer 30 min", kind: "quantity", target: 30, unit: "minutos", cadence: { kind: "daily" }, evidence: null },
      { id: ID(14), goalId: ID(10), name: "Repasar", kind: "tap", target: null, unit: null, cadence: { kind: "daily" }, evidence: null },
    ],
    firstGoalDay: "2026-09-01",
    phases: [],
    phasePositions: {},
    factsByCommitment: {},
    periodDone: { [ID(12)]: 3 },
    monthTask: {},
    monthTaskCounts: {},
    planNotice: {},
  };
  const shaped = shapeDay(loaded);
  assert.equal(shaped.day, "2026-10-05");
  assert.deepEqual(shaped.slots[0].quantity, { value: 45, unit: "minutos", text: "45 min" });
  assert.deepEqual(shaped.slots[0].target, { value: 30, unit: "minutos", text: "30 min" });
  assert.equal(shaped.slots[0].name, "Leer 30 min");
  assert.equal(shaped.slots[0].periodDone, 3);
  assert.equal(shaped.slots[1].quantity, null);
  assert.equal(shaped.slots[1].periodDone, null);
  assert.deepEqual(shaped.goals[0].weekTotal, { value: 90, unit: "minutos", text: "1 h 30 min" });
  assert.deepEqual(shaped.oneOffs.map((o) => o.carried), [true, false]);
  assert.equal(shaped.doneOneOffs[0].factId, ID(23));
  assert.deepEqual(shaped.oneOffs.map((o) => o.note), ["Pedir en la biblioteca\nantes del viernes", null]);
  assert.equal(shaped.doneOneOffs[0].note, "Con la tarjeta");
  assert.equal(shaped.evidence, "unreadable");
  assert.deepEqual(JSON.parse(JSON.stringify(shaped)), shaped);
});

test("the report shapes every figure as an amount and its months as YYYY-MM", () => {
  const report: Report = {
    today: "2026-10-05",
    evidence: "read",
    goals: [
      {
        id: ID(10),
        name: "Leer más",
        horizon: "2027-01-01",
        endedOn: null,
        unit: "páginas",
        measureName: null,
        measureFed: false,
        thisMonth: { planned: 750, reached: 120, underPace: true },
        toDate: { planned: 1350, reached: 570 },
        phases: [{ aim: "Arrancar", startsOn: "2026-08-17", endsOn: "2026-11-01", current: true }],
        tasks: [],
        carried: [
          { name: "Capítulo 1", note: "Del libro azul", from: "2026-09-01", owes: 300, hasAmount: true, children: [{ name: "Leer", note: "Sin celular", owes: 300, hasAmount: true }] },
        ],
        months: [{ month: "2026-09-01", planned: 600, reached: 450, current: false, past: true, carried: 50 }],
        weeks: [],
        weekSplits: [],
      },
    ],
  };
  const shaped = shapeReport(report);
  const goal = shaped.goals[0];
  assert.deepEqual(goal.thisMonth.planned, { value: 750, unit: "páginas" });
  assert.deepEqual(goal.toDate.reached, { value: 570, unit: "páginas" });
  assert.equal(goal.carried[0].from, "2026-09");
  assert.equal(goal.carried[0].note, "Del libro azul");
  assert.equal(goal.carried[0].children[0].note, "Sin celular");
  assert.deepEqual(goal.carried[0].children[0].owes, { value: 300, unit: "páginas" });
  assert.equal(goal.months[0].month, "2026-09");
  assert.equal(goal.months[0].carriedPercent, 50);
  assert.equal(shaped.evidence, "read");
});

test("the report's tasks keep their order, months as YYYY-MM, notes, and minutes as whole minutes", () => {
  const base = {
    id: ID(10),
    name: "Estudiar",
    horizon: "2027-01-01",
    endedOn: null,
    unit: "minutos",
    measureName: null,
    measureFed: false,
    thisMonth: { planned: 750, reached: 0, underPace: false },
    toDate: { planned: 0, reached: 0 },
    phases: [],
    carried: [],
    months: [],
    weeks: [],
    weekSplits: [],
  };
  const report: Report = {
    today: "2026-10-05",
    evidence: "read",
    goals: [
      {
        ...base,
        tasks: [
          { name: "Arrastrada", from: "2026-09-01", done: false, doneOn: null, estimate: 90, part: null, continuesIn: null, owes: 90, hasAmount: true, note: "Del mes pasado", children: [] },
          {
            name: "Madre",
            from: null,
            done: true,
            doneOn: "2026-10-03",
            estimate: null,
            part: null,
            continuesIn: null,
           
            owes: 0,
            hasAmount: true,
            note: null,
            children: [{ name: "Hija", done: true, doneOn: "2026-10-03", estimate: 750, note: "Nota hija" }],
          },
        ],
      },
      {
        ...base,
        unit: null,
        tasks: [{ name: "Sin medida", from: null, done: false, doneOn: null, estimate: null, part: null, continuesIn: null, owes: 0, hasAmount: false, note: null, children: [] }],
      },
    ],
  };
  const [timed, bare] = shapeReport(report).goals;
  assert.deepEqual(timed.tasks.map((task) => task.name), ["Arrastrada", "Madre"]);
  assert.deepEqual(timed.tasks.map((task) => task.from), ["2026-09", null]);
  assert.deepEqual(timed.tasks[0].estimate, { value: 90, unit: "minutos", text: "1 h 30 min" });
  assert.deepEqual(timed.tasks[0].owes, { value: 90, unit: "minutos", text: "1 h 30 min" });
  assert.equal(timed.tasks[0].note, "Del mes pasado");
  assert.deepEqual(timed.tasks[1].children, [
    { name: "Hija", done: true, doneOn: "2026-10-03", estimate: { value: 750, unit: "minutos", text: "12 h 30 min" }, note: "Nota hija" },
  ]);
  assert.equal(timed.tasks[1].doneOn, "2026-10-03");
  assert.deepEqual(bare.tasks[0].estimate, null);
  assert.deepEqual(bare.tasks[0].owes, { value: 0, unit: null });
});

test("loose one-offs keep the two lists apart, the scheduled with their day", () => {
  const shaped = shapeLoose({
    dayless: [{ id: ID(30), name: "Ordenar", goalId: null, goalName: null, note: "Empezar por el estante" }],
    scheduled: [{ id: ID(31), name: "Cita", goalId: ID(10), goalName: "Leer más", note: null, day: "2026-10-09" }],
  });
  assert.deepEqual(shaped, {
    dayless: [{ id: ID(30), name: "Ordenar", goalId: null, goalName: null, note: "Empezar por el estante" }],
    scheduled: [{ id: ID(31), name: "Cita", goalId: ID(10), goalName: "Leer más", note: null, day: "2026-10-09" }],
  });
});
