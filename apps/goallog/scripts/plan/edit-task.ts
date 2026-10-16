// Drives `editTask` (`app/actions/one-offs.ts`, RP-55, RP-57) the way
// `task-actions.ts` drives its siblings: the action imported as a plain async
// function, `server-only`, `next/headers` and `next/cache` stubbed before the
// first `@/` import, and the cookie `harness:mint-session` left standing is
// the session `getPerson()` reads. The pooler only reads rows back, backdates
// a fixture and deletes them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = resolve(process.cwd(), `private/session-${laneNumber()}.json`);
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no session at ${file} — run harness:mint-session first`);
  }
  if (state.cookies.length === 0) {
    throw new Error(`${file} carries no cookie — the mint did not land one`);
  }
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

const revalidated: string[] = [];
let wire: string[] | null = null;

type PostgresFactory = (url: string, options: Record<string, unknown>) => unknown;

function installStubs(cookies: StoredCookie[]): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => cookies, set() {} }) };
    }
    if (request === "next/cache") {
      return { revalidatePath: (path: string) => void revalidated.push(path) };
    }
    // `db/client.ts` is the only `@/` importer of `postgres`; its pool is the
    // one every statement of the action leaves on.
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      const wrapped: PostgresFactory = (url, options) =>
        real(url, {
          ...options,
          debug: (_connection: number, query: string) => {
            wire?.push(query);
          },
        });
      return Object.assign(wrapped, real);
    }
    return originalLoad(request, parent, isMain);
  };
}

type Actions = typeof import("@/app/actions/one-offs");
let actions: Actions;
let createGoal: typeof import("@/app/actions/plan").createGoal;
let pgCode: typeof import("@/lib/db-error").pgCode;

async function edit(input: Parameters<Actions["editTask"]>[0]) {
  try {
    return await actions.editTask(input);
  } catch (error) {
    assert.fail(`editTask threw ${pgCode(error) ?? "without a code"}`);
  }
}

async function fix(input: Parameters<Actions["fixTask"]>[0]) {
  try {
    return await actions.fixTask(input);
  } catch (error) {
    assert.fail(`fixTask threw ${pgCode(error) ?? "without a code"}`);
  }
}

async function created(input: Parameters<Actions["createOneOff"]>[0]): Promise<string> {
  const result = await actions.createOneOff(input);
  if (!result.ok) throw new Error(`createOneOff ${input.name}: ${result.error}`);
  return result.oneOffId;
}

// "YYYY-MM" `delta` months from the one `day` sits in.
function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
let today: string;
let thisMonth: string;
let nextMonth: string;
let lastMonth: string;
let goalId: string;

async function monthsOf(...ids: string[]): Promise<(string | null)[]> {
  const rows = await sql<{ id: string; planned_month: string | null }[]>`
    select id, planned_month::text as planned_month from goals.one_offs where id in ${sql(ids)}`;
  const byId = new Map(rows.map((row) => [row.id, row.planned_month]));
  return ids.map((id) => byId.get(id) ?? null);
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  createGoal = plan.createGoal;
  ({ pgCode } = await import("@/lib/db-error"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
  nextMonth = monthFrom(today, 1);
  lastMonth = monthFrom(today, -1);
  // The 1st of the month after next: next month is the last one the goal plans.
  const made = await createGoal({ name: "RP-55 fixture: editar", horizon: `${monthFrom(today, 2)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
  // Opened last month, so last month is inside the span and already closed.
  await sql`update goals.goals set created_at = ${`${lastMonth}-15T12:00:00Z`} where id = ${goalId}`;
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

async function rowOf(id: string) {
  const [row] = await sql<{ name: string; estimate: number | null; planned_month: string | null }[]>`
    select name, estimate, planned_month::text as planned_month from goals.one_offs where id = ${id}`;
  return row;
}

async function measuredGoal(label: string): Promise<string> {
  const made = await createGoal({ name: `RP-55 fixture: ${label}`, horizon: `${monthFrom(today, 2)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  await sql`update goals.goals set measure_name = 'horas', measure_unit = 'minutos' where id = ${made.goalId}`;
  return made.goalId;
}

test("editTask: name, estimate and month land in one UPDATE; null estimate clears and null month returns the task to the plan", async () => {
  const measured = await measuredGoal("editar");
  const taskId = await created({ name: "RP-55 editar", day: null, goalId: measured, plannedMonth: thisMonth });
  wire = [];
  const result = await edit({ oneOffId: taskId, name: "  RP-55 editada ", estimate: 90, month: nextMonth });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase());
  wire = null;
  assert.deepEqual(result, { ok: true });
  const statements = calls.filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type") && !q.includes("set_config("));
  assert.equal(statements.length, 1, statements.join(" | "));
  assert.ok(statements[0].startsWith("with"), statements[0]);
  assert.deepEqual(await rowOf(taskId), { name: "RP-55 editada", estimate: 90, planned_month: `${nextMonth}-01` });

  // Absent leaves estimate and month alone.
  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-55 sola" }), { ok: true });
  assert.deepEqual(await rowOf(taskId), { name: "RP-55 sola", estimate: 90, planned_month: `${nextMonth}-01` });

  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-55 sola", estimate: null, month: null }), { ok: true });
  assert.deepEqual(await rowOf(taskId), { name: "RP-55 sola", estimate: null, planned_month: null });
  assert.deepEqual(await fix({ oneOffId: taskId, month: thisMonth }), { ok: true });
  assert.deepEqual(await monthsOf(taskId), [`${thisMonth}-01`]);
  assert.deepEqual(await fix({ oneOffId: taskId, month: null }), { ok: true });
  assert.deepEqual(await monthsOf(taskId), [null]);
});

test("editTask: a done task takes a new name and refuses estimate and month", async () => {
  const measured = await measuredGoal("hecha");
  const taskId = await created({ name: "RP-55 hecha", day: null, goalId: measured, plannedMonth: thisMonth, estimate: 30 });
  assert.equal((await actions.completeOneOff({ oneOffId: taskId })).ok, true);
  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-55 hecha, renombrada" }), { ok: true });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "x", estimate: 45 }), { ok: false, error: "roadmap.errors.doneTask" });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "x", month: nextMonth }), { ok: false, error: "roadmap.errors.doneTask" });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "x", month: null }), { ok: false, error: "roadmap.errors.doneTask" });
  assert.deepEqual(await rowOf(taskId), { name: "RP-55 hecha, renombrada", estimate: 30, planned_month: `${thisMonth}-01` });
});

test("editTask: a sub-task's month, an estimate on a parent or on a goal with no measure, and a bad name are refused", async () => {
  const measured = await measuredGoal("rechazos");
  const parentId = await created({ name: "RP-55 padre", day: null, goalId: measured, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-55 hija", day: null, parentId });
  assert.deepEqual(await edit({ oneOffId: childId, name: "RP-55 hija", month: nextMonth }), { ok: false, error: "roadmap.errors.subTaskMonth" });
  assert.deepEqual(await edit({ oneOffId: childId, name: "RP-55 hija", month: null }), { ok: false, error: "roadmap.errors.subTaskMonth" });
  assert.deepEqual(await edit({ oneOffId: childId, name: "RP-55 hija", estimate: 20 }), { ok: true });
  assert.deepEqual(await edit({ oneOffId: parentId, name: "RP-55 padre", estimate: 20 }), { ok: false, error: "roadmap.errors.parentEstimate" });
  assert.deepEqual(await monthsOf(childId), [null]);

  const bare = await created({ name: "RP-55 sin medida", day: null, goalId, plannedMonth: thisMonth });
  assert.deepEqual(await edit({ oneOffId: bare, name: "RP-55 sin medida", estimate: 20 }), { ok: false, error: "month.errors.noMeasure" });
  assert.deepEqual(await edit({ oneOffId: bare, name: "RP-55 sin medida", month: lastMonth }), { ok: false, error: "roadmap.errors.monthEnded" });
  assert.deepEqual(await edit({ oneOffId: bare, name: "RP-55 sin medida", month: monthFrom(today, 2) }), { ok: false, error: "roadmap.errors.monthOutsideSpan" });
  assert.deepEqual(await edit({ oneOffId: bare, name: "   " }), { ok: false, error: "roadmap.errors.nameEmpty" });
  assert.deepEqual(await edit({ oneOffId: bare, name: "a".repeat(121) }), { ok: false, error: "roadmap.errors.nameTooLong" });
  assert.deepEqual(await edit({ oneOffId: bare, name: "x", estimate: 0 }), { ok: false, error: "month.errors.estimateInvalid" });
  assert.deepEqual(await edit({ oneOffId: randomUUID(), name: "x" }), { ok: false, error: "plan.errors.notFound" });
  assert.deepEqual((await rowOf(bare)).name, "RP-55 sin medida");
});

test("editTask: a suelta takes a new name, done or not, and refuses estimate and month with their keys", async () => {
  const looseId = await created({ name: "RP-57 suelta", day: null });
  assert.deepEqual(await edit({ oneOffId: looseId, name: "RP-57 renombrada" }), { ok: true });
  assert.equal((await rowOf(looseId)).name, "RP-57 renombrada");
  assert.deepEqual(await edit({ oneOffId: looseId, name: "RP-57 x", estimate: 10 }), { ok: false, error: "month.errors.noMeasure" });
  assert.deepEqual(await edit({ oneOffId: looseId, name: "RP-57 x", month: thisMonth }), { ok: false, error: "month.errors.invalid" });
  assert.equal((await actions.completeOneOff({ oneOffId: looseId })).ok, true);
  assert.deepEqual(await edit({ oneOffId: looseId, name: "RP-57 hecha" }), { ok: true });
  assert.deepEqual(await rowOf(looseId), { name: "RP-57 hecha", estimate: null, planned_month: null });
  // A goal's one-off outside the plan is no plan task: its name alone lands (rename-goal-one-off.ts).
  const goalLoose = await created({ name: "RP-57 de meta", day: today, goalId });
  assert.deepEqual(await edit({ oneOffId: goalLoose, name: "otra", month: thisMonth }), { ok: false, error: "month.errors.invalid" });
});

test("editTask: a plan task with a day refuses a new month and the plan's return, and takes a new name", async () => {
  const dayId = await created({ name: "RP-55 con día", day: null, goalId, plannedMonth: thisMonth });
  assert.deepEqual(await actions.scheduleOneOff({ oneOffId: dayId, day: monthFrom(today, 1) + "-01" }), { ok: true });
  assert.deepEqual(await edit({ oneOffId: dayId, name: "RP-55 con día", month: nextMonth }), { ok: false, error: "roadmap.errors.dayInMonth" });
  assert.deepEqual(await edit({ oneOffId: dayId, name: "RP-55 con día", month: null }), { ok: false, error: "roadmap.errors.dayInMonth" });
  assert.deepEqual(await fix({ oneOffId: dayId, month: nextMonth }), { ok: false, error: "roadmap.errors.dayInMonth" });
  assert.deepEqual(await edit({ oneOffId: dayId, name: "RP-55 con día, renombrada" }), { ok: true });
  assert.deepEqual(await rowOf(dayId), { name: "RP-55 con día, renombrada", estimate: null, planned_month: `${thisMonth}-01` });
});
