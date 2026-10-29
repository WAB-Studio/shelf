// Drives `fixTask` (`app/actions/one-offs.ts`, RP-51) the way
// `task-actions.ts` drives its siblings: the action imported as a plain async
// function, `server-only`, `next/headers` and `next/cache` stubbed before the
// first `@/` import, and the cookie `harness:mint-session` left standing is
// the session `getPerson()` reads. The pooler only reads rows back, backdates
// a fixture and deletes them.
import assert from "node:assert/strict";
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
  const made = await createGoal({ name: "RP-51 fixture: mover", horizon: `${monthFrom(today, 2)}-01` });
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

test("fixTask: a task of this month moves to next month with its children, in at most three statements", async () => {
  const taskId = await created({ name: "RP-51 mover", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-51 mover hija", day: null, parentId: taskId, estimate: undefined });
  revalidated.length = 0;
  wire = [];
  const result = await fix({ oneOffId: taskId, month: nextMonth });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase());
  wire = null;
  assert.deepEqual(result, { ok: true });
  const statements = calls.filter(
    (q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type"),
  ).length;
  assert.ok(statements <= 3, `${statements} statements: ${calls.join(" | ")}`);

  assert.deepEqual(await monthsOf(taskId, childId), [`${nextMonth}-01`, null]);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.one_offs where parent_id = ${taskId}`;
  assert.equal(count, 1);
  assert.ok(revalidated.includes(`/metas/${goalId}`), revalidated.join(" "));
  // The list of the destination reads it.
  const { loadGoal } = await import("@/lib/queries/goal");
  const { monthList } = await import("@/lib/plan/carry");
  const { todayInZone } = await import("@/lib/zone");
  const view = await loadGoal(goalId, todayInZone());
  assert.ok(view);
  const inDestination = monthList(view.tasks, `${nextMonth}-01`, today).find((item) => item.task.id === taskId);
  assert.ok(inDestination, "the task is listed under the destination month");
  assert.deepEqual(inDestination.children.map((child) => child.id), [childId]);
  const inOrigin = monthList(view.tasks, `${thisMonth}-01`, today);
  assert.ok(!inOrigin.some((item) => item.task.id === taskId || item.children.some((child) => child.id === childId)));
});

test("fixTask: a closed month and a month outside the span are refused and the task stays", async () => {
  const taskId = await created({ name: "RP-51 quieta", day: null, goalId, plannedMonth: thisMonth });
  const closed = await fix({ oneOffId: taskId, month: lastMonth });
  assert.deepEqual(closed, { ok: false, error: "roadmap.errors.monthEnded" });
  for (const month of [monthFrom(today, -2), monthFrom(today, 2)]) {
    const outside = await fix({ oneOffId: taskId, month });
    assert.deepEqual(outside, { ok: false, error: "roadmap.errors.monthOutsideSpan" }, month);
  }
  assert.deepEqual(await monthsOf(taskId), [`${thisMonth}-01`]);
});

test("fixTask: a done task and one with a done child are refused as doneTask", async () => {
  const doneId = await created({ name: "RP-51 hecha", day: null, goalId, plannedMonth: thisMonth });
  const completed = await actions.completeOneOff({ oneOffId: doneId });
  assert.equal(completed.ok, true, JSON.stringify(completed));

  const parentId = await created({ name: "RP-51 padre", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-51 hija hecha", day: null, parentId });
  const childDone = await actions.completeOneOff({ oneOffId: childId });
  assert.equal(childDone.ok, true, JSON.stringify(childDone));

  for (const id of [doneId, parentId]) {
    assert.deepEqual(await fix({ oneOffId: id, month: nextMonth }), { ok: false, error: "roadmap.errors.doneTask" });
  }
  assert.deepEqual(await monthsOf(doneId, parentId), [`${thisMonth}-01`, `${thisMonth}-01`]);
});

test("fixTask: a sub-task, a one-off with no month and an id that is nobody's are refused", async () => {
  const parentId = await created({ name: "RP-51 padre solo", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-51 hija sola", day: null, parentId });
  assert.deepEqual(await fix({ oneOffId: childId, month: nextMonth }), { ok: false, error: "roadmap.errors.subTaskMonth" });

  const plainId = await created({ name: "RP-51 suelta", day: today, goalId });
  assert.deepEqual(await fix({ oneOffId: plainId, month: nextMonth }), { ok: false, error: "month.errors.invalid" });

  const nobody = await fix({ oneOffId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", month: nextMonth });
  assert.deepEqual(nobody, { ok: false, error: "plan.errors.notFound" });
  assert.deepEqual(await fix({ oneOffId: parentId, month: "2026-13" }), { ok: false, error: "month.errors.monthInvalid" });
  assert.deepEqual(await monthsOf(parentId, childId), [`${thisMonth}-01`, null]);
});

test("fixTask: another person's task is not found and keeps its month; an archived goal's task is closed", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");

  const [foreignGoal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-51 ajena', ${`${monthFrom(today, 2)}-01`}) returning id`;
  try {
    const [foreign] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${member.id}, ${foreignGoal.id}, 'RP-51 tarea ajena', ${`${thisMonth}-01`}) returning id`;
    assert.deepEqual(await fix({ oneOffId: foreign.id, month: nextMonth }), { ok: false, error: "plan.errors.notFound" });
    assert.deepEqual(await monthsOf(foreign.id), [`${thisMonth}-01`]);
  } finally {
    await sql`delete from goals.goals where id = ${foreignGoal.id} and user_id = ${member.id}`;
  }

  const plan = await import("@/app/actions/plan");
  const made = await createGoal({ name: "RP-51 fixture: archivada", horizon: `${monthFrom(today, 2)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  const taskId = await created({ name: "RP-51 de archivada", day: null, goalId: made.goalId, plannedMonth: thisMonth });
  const archived = await plan.archiveGoal({ goalId: made.goalId });
  if (!archived.ok) throw new Error(`archiveGoal: ${archived.error}`);
  assert.deepEqual(await fix({ oneOffId: taskId, month: nextMonth }), { ok: false, error: "month.errors.closed" });
  assert.deepEqual(await monthsOf(taskId), [`${thisMonth}-01`]);
});

test("fixTask: a task added to the plan with inPlan lands unfixed and can be fixed", async () => {
  const taskId = await created({ name: "RP-50 al plan", day: null, goalId, inPlan: true });
  const [row] = await sql<{ in_plan: boolean; planned_month: string | null }[]>`
    select in_plan, planned_month::text as planned_month from goals.one_offs where id = ${taskId}`;
  assert.deepEqual(row, { in_plan: true, planned_month: null });
  assert.deepEqual(await fix({ oneOffId: taskId, month: nextMonth }), { ok: true });
  assert.deepEqual(await monthsOf(taskId), [`${nextMonth}-01`]);
  const refused = await actions.createOneOff({ name: "RP-50 sin meta", day: null, inPlan: true });
  assert.deepEqual(refused, { ok: false, error: "month.errors.invalid" });
});

test("fixTask and editTask: a goal whose horizon is today has ended yesterday and refuses; one ending tomorrow does not (RP-51, RP-55)", async () => {
  // The session person owns the fixture goal; the rows seeded below are theirs.
  const [me] = await sql<{ id: string }[]>`select user_id as id from goals.goals where id = ${goalId}`;

  const seeded: string[] = [];
  try {
    const goal = async (name: string, horizon: string): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon) values (${me.id}, ${name}, ${horizon}) returning id`;
      seeded.push(row.id);
      return row.id;
    };
    const task = async (id: string, name: string): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, in_plan)
        values (${me.id}, ${id}, ${name}, true) returning id`;
      return row.id;
    };
    const nameOf = async (id: string) =>
      (await sql<{ name: string }[]>`select name from goals.one_offs where id = ${id}`)[0].name;

    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowDay = tomorrow.toISOString().slice(0, 10);

    const ended = await goal("RP-51 fixture: termina hoy", today);
    const toFix = await task(ended, "RP-51 horizonte hoy fijar");
    const toEdit = await task(ended, "RP-55 horizonte hoy editar");
    const closed = { ok: false, error: "month.errors.closed" };

    assert.deepEqual(await fix({ oneOffId: toFix, month: thisMonth }), closed);
    assert.deepEqual(await monthsOf(toFix), [null]);
    assert.deepEqual(await actions.editTask({ oneOffId: toEdit, name: "otro nombre", month: thisMonth }), closed);
    assert.deepEqual(await monthsOf(toEdit), [null]);
    assert.equal(await nameOf(toEdit), "RP-55 horizonte hoy editar");

    const open = await goal("RP-51 fixture: termina mañana", tomorrowDay);
    const openTask = await task(open, "RP-51 horizonte mañana");
    assert.deepEqual(await fix({ oneOffId: openTask, month: thisMonth }), { ok: true });
    assert.deepEqual(await monthsOf(openTask), [`${thisMonth}-01`]);
  } finally {
    if (seeded.length > 0) await sql`delete from goals.goals where id in ${sql(seeded)}`;
  }
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.goals where name like 'RP-51 fixture: termina %'`;
  assert.equal(count, 0);
});
