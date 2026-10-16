// Drives module 1013 (RP-127, RP-134) as two people through `actAs`: `deleteGoal`, `changeGoalMeasure`,
// `removeGoalMeasure` (`app/actions/goal-edit.ts`) and `removeRhythm` (`app/actions/roadmap.ts`), and the two flags
// `loadGoal` reads beside them. The admin pool plants only what no action writes (a month's amount, a goal's age,
// a unit the person could not reach) and reads rows back. A refusal is judged by its key and by every row it left.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
(globalThis as unknown as { sql: unknown }).sql = door;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let edit: typeof import("@/app/actions/goal-edit");
let roadmap: typeof import("@/app/actions/roadmap");
let plan: typeof import("@/app/actions/plan");
let facts: typeof import("@/app/actions/facts");
let oneOffs: typeof import("@/app/actions/one-offs");
let goalQueries: typeof import("@/lib/queries/goal");
let owner: Person;
let stranger: Person;
let today: string;
let thisMonth: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);
const mine = <T>(fn: () => Promise<T>) => as(owner, fn);

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const goalIds: string[] = [];
const NOWHERE = "00000000-0000-4000-8000-000000000000";

async function goal(name: string, unit: string | null = "minutos", person: Person = owner) {
  const created = await as(person, () => plan.createGoal({ name, horizon: `${monthFrom(today, 3)}-01` }));
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalIds.push(created.goalId);
  let commitmentId: string | null = null;
  if (unit !== null) {
    const commitment = await as(person, () =>
      plan.addCommitment({
        goalId: created.goalId,
        name: "cuenta",
        cadenceKind: "daily",
        satisfaction: "quantity",
        targetQuantity: 10,
        unit,
      }),
    );
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    commitmentId = commitment.commitmentId;
  }
  return { goalId: created.goalId, commitmentId };
}

async function childOf(parentId: string, name: string): Promise<string> {
  const made = await mine(() => plan.createGoal({ name, horizon: `${monthFrom(today, 2)}-01`, parentId }));
  if (!made.ok) throw new Error(`createGoal(child): ${made.error}`);
  goalIds.push(made.goalId);
  return made.goalId;
}

async function evidenceOn(goalId: string): Promise<void> {
  const made = await mine(() =>
    plan.addCommitment({
      goalId,
      name: "lecturas",
      cadenceKind: "daily",
      satisfaction: "evidence",
      sourceKey: "reading_lookups",
      threshold: 1,
    }),
  );
  if (!made.ok) throw new Error(`addCommitment(evidence): ${made.error}`);
}

async function factOn(commitmentId: string, quantity = 7): Promise<void> {
  const fact = await mine(() => facts.declareFact({ commitmentId, quantity }));
  if (!fact.ok) throw new Error(`declareFact: ${fact.error}`);
}

async function task(goalId: string, name: string, estimate?: number): Promise<string> {
  const made = await mine(() =>
    oneOffs.createOneOff({ name, day: null, goalId, plannedMonth: thisMonth, ...(estimate ? { estimate } : {}) }),
  );
  if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
  return made.oneOffId;
}

async function subtask(parentId: string, name: string): Promise<string> {
  const made = await mine(() => oneOffs.createOneOff({ name, day: null, parentId }));
  if (!made.ok) throw new Error(`createOneOff(sub): ${made.error}`);
  return made.oneOffId;
}

async function done(oneOffId: string): Promise<void> {
  const result = await mine(() => oneOffs.completeOneOff({ oneOffId }));
  if (!result.ok) throw new Error(`completeOneOff: ${result.error}`);
}

async function openedTwoMonthsAgo(goalId: string): Promise<void> {
  await admin`update goals.goals set created_at = ${`${monthFrom(today, -2)}-15T12:00:00Z`} where id = ${goalId}`;
}

async function budgets(goalId: string): Promise<{ month: string; amount: number }[]> {
  const rows = await admin<{ month: string; amount: number }[]>`
    select month::text as month, amount from goals.month_budgets where goal_id = ${goalId} order by month`;
  return rows.map(({ month, amount }) => ({ month, amount }));
}

async function plantBudget(goalId: string, month: string, amount: number): Promise<void> {
  await admin`insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${owner.id}, ${goalId}, ${`${month}-01`}, ${amount})`;
}

async function measureOf(goalId: string) {
  const [row] = await admin<{ name: string | null; unit: string | null; rhythm: number | null }[]>`
    select measure_name as name, measure_unit as unit, rhythm from goals.goals where id = ${goalId}`;
  return row;
}

// Rows the goal owns in the tables a delete must take with it, and the facts that would forbid it.
async function rowsOf(goalId: string): Promise<Record<string, number>> {
  const [row] = await admin<Record<string, number>[]>`
    select (select count(*)::int from goals.goals where id = ${goalId}) as goals,
           (select count(*)::int from goals.phases where goal_id = ${goalId}) as phases,
           (select count(*)::int from goals.commitments where goal_id = ${goalId}) as commitments,
           (select count(*)::int from goals.one_offs where goal_id = ${goalId}) as one_offs,
           (select count(*)::int from goals.month_budgets where goal_id = ${goalId}) as month_budgets,
           (select count(*)::int from goals.facts f
              where f.goal_id = ${goalId}
                 or f.commitment_id in (select id from goals.commitments where goal_id = ${goalId})
                 or f.one_off_id in (select id from goals.one_offs where goal_id = ${goalId})
                 or f.one_off_id in (select s.id from goals.one_offs s join goals.one_offs o on s.parent_id = o.id
                                      where o.goal_id = ${goalId})) as facts`;
  return row;
}

async function view(goalId: string) {
  const loaded = await mine(() => goalQueries.loadGoal(goalId));
  assert.ok(loaded, "loadGoal found the goal");
  return loaded;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  edit = await import("@/app/actions/goal-edit");
  roadmap = await import("@/app/actions/roadmap");
  plan = await import("@/app/actions/plan");
  facts = await import("@/app/actions/facts");
  oneOffs = await import("@/app/actions/one-offs");
  goalQueries = await import("@/lib/queries/goal");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
  const runId = await openCheckRun(admin);
  [owner, stranger] = await createPeople(admin, runId, door, 2);
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

// ---------------------------------------------------------------- deleteGoal

test("deleteGoal: a goal with no fact goes with its phases, commitments, tasks, sub-tasks and month amounts", async () => {
  const { goalId } = await goal("sin hechos");
  const added = await mine(() =>
    plan.addPhase({ goalId, aim: "arrancar", startsOn: `${thisMonth}-01`, endsOn: `${monthFrom(today, 1)}-01` }),
  );
  assert.ok(added.ok, JSON.stringify(added));
  await subtask(await task(goalId, "tarea"), "sub");
  await plantBudget(goalId, monthFrom(today, 1), 90);
  const before = await rowsOf(goalId);
  assert.deepEqual(
    [before.goals, before.phases, before.commitments, before.one_offs, before.month_budgets],
    [1, 1, 1, 2, 1],
  );

  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: true });
  assert.deepEqual(await rowsOf(goalId), {
    goals: 0,
    phases: 0,
    commitments: 0,
    one_offs: 0,
    month_budgets: 0,
    facts: 0,
  });
});

test("deleteGoal: an archived goal and an ended goal with no fact go too", async () => {
  const archived = (await goal("archivada sin hechos")).goalId;
  const ended = (await goal("terminada sin hechos")).goalId;
  assert.ok((await mine(() => plan.archiveGoal({ goalId: archived }))).ok);
  await admin`update goals.goals set horizon = ${today} where id = ${ended}`;
  for (const goalId of [archived, ended]) {
    assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: true });
    assert.equal((await rowsOf(goalId)).goals, 0);
  }
});

test("deleteGoal: a goal whose commitment has a fact is refused by key and keeps every row", async () => {
  const { goalId, commitmentId } = await goal("con hecho de compromiso");
  await factOn(commitmentId!);
  await plantBudget(goalId, monthFrom(today, 1), 50);
  const before = await rowsOf(goalId);
  assert.equal(before.facts, 1);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: false, error: "plan.errors.goalHasFacts" });
  assert.deepEqual(await rowsOf(goalId), before);
});

test("deleteGoal: a fact on one of its tasks refuses it and keeps the task", async () => {
  const { goalId } = await goal("con hecho de tarea");
  await done(await task(goalId, "hecha"));
  const before = await rowsOf(goalId);
  assert.equal(before.facts, 1);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: false, error: "plan.errors.goalHasFacts" });
  assert.deepEqual(await rowsOf(goalId), before);
});

test("deleteGoal: a fact on a sub-task alone refuses it, archived or not", async () => {
  const { goalId } = await goal("con hecho de sub-tarea");
  await done(await subtask(await task(goalId, "padre"), "hija hecha"));
  const before = await rowsOf(goalId);
  assert.equal(before.facts, 1);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: false, error: "plan.errors.goalHasFacts" });
  assert.deepEqual(await rowsOf(goalId), before);

  assert.ok((await mine(() => plan.archiveGoal({ goalId }))).ok);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId })), { ok: false, error: "plan.errors.goalHasFacts" });
  assert.deepEqual(await rowsOf(goalId), before);
});

test("deleteGoal: a goal holding a goal, even an archived one, answers goalHoldsGoals and both stay", async () => {
  const holder = (await goal("madre")).goalId;
  const child = await childOf(holder, "hija");
  const stays = async () => (await rowsOf(holder)).goals + (await rowsOf(child)).goals;
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: holder })), {
    ok: false,
    error: "plan.errors.goalHoldsGoals",
  });
  assert.equal(await stays(), 2);

  assert.ok((await mine(() => plan.archiveGoal({ goalId: child }))).ok);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: holder })), {
    ok: false,
    error: "plan.errors.goalHoldsGoals",
  });
  assert.equal(await stays(), 2);
  // Taken out first, the holder goes.
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: child })), { ok: true });
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: holder })), { ok: true });
});

test("deleteGoal: a goal not there or someone else's is goalNotFound, and the other person's stays", async () => {
  const theirs = (await goal("ajena", "minutos", stranger)).goalId;
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: theirs })), {
    ok: false,
    error: "plan.errors.goalNotFound",
  });
  assert.equal((await rowsOf(theirs)).goals, 1);
  assert.deepEqual(await mine(() => edit.deleteGoal({ goalId: NOWHERE })), {
    ok: false,
    error: "plan.errors.goalNotFound",
  });
});

// ------------------------------------------------- the goal's read agrees

test("loadGoal: deletable is exactly what a delete does, over six shapes", async () => {
  const shapes: [string, () => Promise<string>][] = [
    ["bare", async () => (await goal("forma lisa")).goalId],
    [
      "commitment fact",
      async () => {
        const made = await goal("forma compromiso");
        await factOn(made.commitmentId!);
        return made.goalId;
      },
    ],
    [
      "task fact",
      async () => {
        const made = await goal("forma tarea");
        await done(await task(made.goalId, "t"));
        return made.goalId;
      },
    ],
    [
      "sub-task fact",
      async () => {
        const made = await goal("forma sub-tarea");
        await done(await subtask(await task(made.goalId, "p"), "s"));
        return made.goalId;
      },
    ],
    [
      "holds a goal",
      async () => {
        const made = await goal("forma madre");
        await childOf(made.goalId, "forma hija");
        return made.goalId;
      },
    ],
    [
      "holds an archived goal",
      async () => {
        const made = await goal("forma madre archivada");
        const child = await childOf(made.goalId, "forma hija archivada");
        assert.ok((await mine(() => plan.archiveGoal({ goalId: child }))).ok);
        return made.goalId;
      },
    ],
  ];
  const seen: Record<string, boolean> = {};
  for (const [label, build] of shapes) {
    const goalId = await build();
    const deletable = (await view(goalId)).deletable;
    assert.equal(typeof deletable, "boolean", `${label}: deletable is a boolean`);
    seen[label] = deletable;
    const result = await mine(() => edit.deleteGoal({ goalId }));
    assert.equal(result.ok, deletable, `${label}: the flag and the act agree`);
  }
  assert.deepEqual(seen, {
    bare: true,
    "commitment fact": false,
    "task fact": false,
    "sub-task fact": false,
    "holds a goal": false,
    "holds an archived goal": false,
  });
});

test("loadGoal: measureFed is exactly what changeGoalMeasure refuses by, over four shapes", async () => {
  const seen: Record<string, boolean> = {};
  const judge = async (label: string, goalId: string) => {
    const flag = (await view(goalId)).measureFed;
    assert.equal(typeof flag, "boolean", `${label}: measureFed is a boolean`);
    seen[label] = flag;
    const result = await mine(() => edit.changeGoalMeasure({ goalId, name: "otra", unit: "otra" }));
    assert.equal(!result.ok && result.error === "plan.errors.measureFed", flag, `${label}: the flag and the act agree`);
  };

  await judge("no fact", (await goal("medida sin hechos")).goalId);

  const quantity = await goal("medida con cantidad");
  await factOn(quantity.commitmentId!);
  await judge("a quantity in its unit", quantity.goalId);

  const evidence = await goal("medida con evidencia", null);
  assert.ok((await mine(() => plan.setGoalMeasure({ goalId: evidence.goalId, name: "Búsquedas", unit: "searches" }))).ok);
  await evidenceOn(evidence.goalId);
  await judge("an evidence commitment in its unit", evidence.goalId);

  const taskOnly = await goal("medida solo tarea");
  await done(await task(taskOnly.goalId, "estimada", 30));
  await judge("a done estimated task", taskOnly.goalId);

  assert.deepEqual(seen, {
    "no fact": false,
    "a quantity in its unit": true,
    "an evidence commitment in its unit": true,
    "a done estimated task": false,
  });
});

// ---------------------------------------------------------- changeGoalMeasure

async function measuredWithPlan(name: string, unit = "minutos") {
  const made = await goal(name, unit);
  await openedTwoMonthsAgo(made.goalId);
  assert.deepEqual(await mine(() => roadmap.setRhythm({ goalId: made.goalId, amount: 720 })), { ok: true });
  await plantBudget(made.goalId, monthFrom(today, 1), 300);
  await plantBudget(made.goalId, monthFrom(today, 2), 400);
  return made.goalId;
}

test("changeGoalMeasure: a new name in the same unit keeps the rhythm and every month amount", async () => {
  const goalId = await measuredWithPlan("solo nombre");
  const amounts = await budgets(goalId);
  assert.equal(amounts.length, 2);
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Minutos hablados", unit: "minutos" })), {
    ok: true,
  });
  assert.deepEqual(await measureOf(goalId), { name: "Minutos hablados", unit: "minutos", rhythm: 720 });
  assert.deepEqual(await budgets(goalId), amounts);
});

test("changeGoalMeasure: a new unit clears the rhythm and every month amount, and only this goal's", async () => {
  const goalId = await measuredWithPlan("otra unidad");
  const other = await measuredWithPlan("vecina intacta");
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Páginas leídas", unit: "páginas" })), {
    ok: true,
  });
  assert.deepEqual(await measureOf(goalId), { name: "Páginas leídas", unit: "páginas", rhythm: null });
  assert.deepEqual(await budgets(goalId), []);
  assert.equal((await measureOf(other)).rhythm, 720);
  assert.equal((await budgets(other)).length, 2);
});

test("changeGoalMeasure: hours are stored as minutes, so on a minutes goal they keep the rhythm; on km they clear it", async () => {
  const goalId = await measuredWithPlan("horas sobre minutos");
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Tiempo", unit: "horas" })), { ok: true });
  assert.deepEqual(await measureOf(goalId), { name: "Tiempo", unit: "minutos", rhythm: 720 });
  assert.equal((await budgets(goalId)).length, 2);

  const km = await measuredWithPlan("horas sobre km", "km");
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId: km, name: "Tiempo", unit: "horas" })), { ok: true });
  assert.deepEqual(await measureOf(km), { name: "Tiempo", unit: "minutos", rhythm: null });
  assert.deepEqual(await budgets(km), []);
});

test("changeGoalMeasure: a measure a quantity feeds is refused by key and nothing moves", async () => {
  const { goalId, commitmentId } = await goal("alimentada");
  await openedTwoMonthsAgo(goalId);
  assert.deepEqual(await mine(() => roadmap.setRhythm({ goalId, amount: 720 })), { ok: true });
  await plantBudget(goalId, monthFrom(today, 1), 300);
  await factOn(commitmentId!);
  const before = { measure: await measureOf(goalId), budgets: await budgets(goalId) };
  for (const unit of ["minutos", "páginas"]) {
    assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Nueva", unit })), {
      ok: false,
      error: "plan.errors.measureFed",
    });
  }
  assert.deepEqual({ measure: await measureOf(goalId), budgets: await budgets(goalId) }, before);
});

test("changeGoalMeasure: a fact in another unit than the measure's feeds nothing", async () => {
  const { goalId, commitmentId } = await goal("otra unidad en el hecho", "km");
  await factOn(commitmentId!);
  // Reached by an older edit no action offers now: the measure reads minutes while the fact is in km.
  await admin`update goals.goals set measure_name = 'minutos', measure_unit = 'minutos' where id = ${goalId}`;
  assert.equal((await view(goalId)).measureFed, false);
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Páginas", unit: "páginas" })), { ok: true });
  assert.equal((await measureOf(goalId)).unit, "páginas");
});

test("changeGoalMeasure: a done task with an estimate and no block feeds nothing (RP-128)", async () => {
  const { goalId } = await goal("tarea sola");
  await done(await task(goalId, "estimada", 45));
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Páginas", unit: "páginas" })), { ok: true });
  assert.equal((await measureOf(goalId)).unit, "páginas");
});

test("changeGoalMeasure and removeGoalMeasure: an evidence commitment in the measure's unit feeds it with no fact at all", async () => {
  const { goalId } = await goal("evidencia", null);
  assert.ok((await mine(() => plan.setGoalMeasure({ goalId, name: "Búsquedas", unit: "searches" }))).ok);
  await evidenceOn(goalId);
  assert.equal((await rowsOf(goalId)).facts, 0);
  const before = await measureOf(goalId);
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "Otra", unit: "otra" })), {
    ok: false,
    error: "plan.errors.measureFed",
  });
  assert.deepEqual(await mine(() => edit.removeGoalMeasure({ goalId })), { ok: false, error: "plan.errors.measureFed" });
  assert.deepEqual(await measureOf(goalId), before);

  // The same evidence commitment under a goal measured in another unit feeds nothing.
  const other = await goal("evidencia ajena a su unidad");
  await evidenceOn(other.goalId);
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId: other.goalId, name: "Páginas", unit: "páginas" })), {
    ok: true,
  });
});

test("changeGoalMeasure and removeGoalMeasure: no measure, a goal holding goals, and a goal not there answer their keys", async () => {
  const bare = (await goal("sin medida", null)).goalId;
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId: bare, name: "X", unit: "x" })), {
    ok: false,
    error: "plan.errors.noMeasure",
  });
  assert.deepEqual(await mine(() => edit.removeGoalMeasure({ goalId: bare })), { ok: false, error: "plan.errors.noMeasure" });

  const holder = (await goal("madre medida")).goalId;
  await childOf(holder, "hija medida");
  assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId: holder, name: "X", unit: "x" })), {
    ok: false,
    error: "plan.errors.holderNoMeasure",
  });

  const theirs = (await goal("medida ajena", "minutos", stranger)).goalId;
  for (const goalId of [theirs, NOWHERE]) {
    assert.deepEqual(await mine(() => edit.changeGoalMeasure({ goalId, name: "X", unit: "x" })), {
      ok: false,
      error: "plan.errors.goalNotFound",
    });
    assert.deepEqual(await mine(() => edit.removeGoalMeasure({ goalId })), { ok: false, error: "plan.errors.goalNotFound" });
  }
  assert.equal((await measureOf(theirs)).unit, "minutos");
});

// ---------------------------------------------------------- removeGoalMeasure

test("removeGoalMeasure: clears the name, the unit, the rhythm and the goal's month amounts", async () => {
  const goalId = await measuredWithPlan("quitar medida");
  const other = await measuredWithPlan("otra intacta");
  assert.deepEqual(await mine(() => edit.removeGoalMeasure({ goalId })), { ok: true });
  assert.deepEqual(await measureOf(goalId), { name: null, unit: null, rhythm: null });
  assert.deepEqual(await budgets(goalId), []);
  assert.equal((await measureOf(other)).rhythm, 720);
  assert.equal((await budgets(other)).length, 2);
});

// --------------------------------------------------------------- removeRhythm

test("removeRhythm: every closed month reads the amount it read before, and the rhythm is gone", async () => {
  const { goalId } = await goal("quitar ritmo");
  await openedTwoMonthsAgo(goalId);
  assert.deepEqual(await mine(() => roadmap.setRhythm({ goalId, amount: 720 })), { ok: true });
  await plantBudget(goalId, monthFrom(today, -1), 55);
  const closed = (v: Awaited<ReturnType<typeof view>>) =>
    v.months.filter((m) => m.month < `${thisMonth}-01`).map((m) => [m.month, m.planned]);
  const readBefore = closed(await view(goalId));
  assert.equal(readBefore.length, 2);
  assert.ok(readBefore.every(([, planned]) => planned !== null));
  // Opened on the 15th: the first month's share is under the whole rhythm, so an unfrozen or rounded read shows.
  assert.ok((readBefore[0][1] as number) < 720);
  assert.equal(readBefore[1][1], 55);

  assert.deepEqual(await mine(() => roadmap.removeRhythm({ goalId })), { ok: true });
  assert.equal((await measureOf(goalId)).rhythm, null);
  assert.deepEqual(closed(await view(goalId)), readBefore);
  // The open month and the ones to come get no amount written.
  assert.ok(!(await budgets(goalId)).some((row) => row.month >= `${thisMonth}-01`));
});

test("removeRhythm: a goal with no rhythm answers noRhythm, someone else's goalNotFound and keeps its rhythm", async () => {
  const { goalId } = await goal("sin ritmo");
  assert.deepEqual(await mine(() => roadmap.removeRhythm({ goalId })), { ok: false, error: "roadmap.errors.noRhythm" });
  assert.deepEqual(await budgets(goalId), []);
  const theirs = (await goal("ritmo ajeno", "minutos", stranger)).goalId;
  await admin`update goals.goals set rhythm = 100 where id = ${theirs}`;
  assert.deepEqual(await mine(() => roadmap.removeRhythm({ goalId: theirs })), {
    ok: false,
    error: "plan.errors.goalNotFound",
  });
  assert.equal((await measureOf(theirs)).rhythm, 100);
});
