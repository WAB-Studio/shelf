// Drives the estimate refusal of `createOneOff`, `editTask` and `fixTask`
// (`app/actions/one-offs.ts`, RP-65): a task of a goal measured in anything
// but time carries no figure. Stubbed the way `edit-task.ts` is; the pooler
// only reads rows back, sets a goal's measure and deletes the fixtures.
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
const wire: string[] | null = null;

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

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  createGoal = plan.createGoal;
  ({ pgCode } = await import("@/lib/db-error"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  thisMonth = today.slice(0, 7);
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.goals where name like 'RP-65 fixture%'`;
  await sql.end();
  assert.equal(count, 0, "fixture goals left behind");
});

async function goalMeasuring(label: string, unit: string | null): Promise<string> {
  const made = await createGoal({ name: `RP-65 fixture: ${label}`, horizon: `${monthFrom(today, 2)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  if (unit !== null) {
    await sql`update goals.goals set measure_name = 'medida', measure_unit = ${unit} where id = ${made.goalId}`;
  }
  return made.goalId;
}

async function rowOf(id: string) {
  const [row] = await sql<{ name: string; estimate: number | null }[]>`
    select name, estimate from goals.one_offs where id = ${id}`;
  return row;
}

async function countIn(goal: string): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.one_offs where goal_id = ${goal}`;
  return count;
}

const NOT_TIME = { ok: false, error: "month.errors.estimateNotTime" };

test("createOneOff: an estimate in a goal measured in km is refused and nothing is written", async () => {
  const km = await goalMeasuring("crear km", "km");
  const result = await actions.createOneOff({ name: "RP-65 zapatillas", day: null, goalId: km, plannedMonth: thisMonth, estimate: 3 });
  assert.deepEqual(result, NOT_TIME);
  assert.equal(await countIn(km), 0);
  // No figure, no refusal.
  assert.equal((await actions.createOneOff({ name: "RP-65 sin cifra", day: null, goalId: km, plannedMonth: thisMonth })).ok, true);
});

test("createOneOff: a sub-task under a parent in a km goal is refused too", async () => {
  const km = await goalMeasuring("sub km", "km");
  const parentId = await created({ name: "RP-65 madre", day: null, goalId: km, plannedMonth: thisMonth });
  const result = await actions.createOneOff({ name: "RP-65 hija", day: null, parentId, estimate: 3 });
  assert.deepEqual(result, NOT_TIME);
  assert.equal(await countIn(km), 1);
});

test("editTask: an estimate in a km goal is refused and stays null; a name alone still writes; fixTask moves", async () => {
  const km = await goalMeasuring("editar km", "km");
  const taskId = await created({ name: "RP-65 editar", day: null, goalId: km, plannedMonth: thisMonth });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-65 editar", estimate: 3 }), NOT_TIME);
  assert.deepEqual(await rowOf(taskId), { name: "RP-65 editar", estimate: null });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-65 nuevo nombre" }), { ok: true });
  assert.deepEqual(await rowOf(taskId), { name: "RP-65 nuevo nombre", estimate: null });
  assert.deepEqual(await fix({ oneOffId: taskId, month: monthFrom(today, 1) }), { ok: true });
});

test("a goal measured in minutos or MIN takes an estimate on create and on edit", async () => {
  for (const unit of ["minutos", "MIN"]) {
    const goal = await goalMeasuring(`tiempo ${unit}`, unit);
    const taskId = await created({ name: `RP-65 ${unit}`, day: null, goalId: goal, plannedMonth: thisMonth, estimate: 30 });
    assert.deepEqual(await rowOf(taskId), { name: `RP-65 ${unit}`, estimate: 30 }, unit);
    assert.deepEqual(await edit({ oneOffId: taskId, name: `RP-65 ${unit}`, estimate: 45 }), { ok: true }, unit);
    assert.deepEqual(await rowOf(taskId), { name: `RP-65 ${unit}`, estimate: 45 }, unit);
  }
});

test("a goal with no measure still answers noMeasure, before the unit refusal", async () => {
  const bare = await goalMeasuring("sin medida", null);
  const result = await actions.createOneOff({ name: "RP-65 nada", day: null, goalId: bare, plannedMonth: thisMonth, estimate: 3 });
  assert.deepEqual(result, { ok: false, error: "month.errors.noMeasure" });
  const taskId = await created({ name: "RP-65 nada", day: null, goalId: bare, plannedMonth: thisMonth });
  assert.deepEqual(await edit({ oneOffId: taskId, name: "RP-65 nada", estimate: 3 }), { ok: false, error: "month.errors.noMeasure" });
});
