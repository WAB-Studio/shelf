// What a goal holding goals refuses (RP-80): a rhythm, a month amount, a task back to the plan.
// Wired like `tree-actions.ts`: `server-only`, `next/headers` and `next/cache` stubbed, the lane's
// minted session as the caller. Fixture goals go in through the owner connection; every refusal
// is read back as rows that did not move.
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
      return { revalidatePath() {} };
    }
    return originalLoad(request, parent, isMain);
  };
}

type Roadmap = typeof import("@/app/actions/roadmap");
type Budgets = typeof import("@/app/actions/budgets");
type OneOffs = typeof import("@/app/actions/one-offs");
let roadmap: Roadmap;
let budgets: Budgets;
let oneOffs: OneOffs;

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

let today: string;
let userId: string;
const horizonAt = (months: number) => `${monthFrom(today, months)}-01`;

// A time-measured goal, with or without a goal inside; the tree's triggers still judge it.
async function mk(name: string, parentId: string | null = null, unit: string | null = "minutos"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit)
    values (${userId}, ${name}, ${horizonAt(6)}, ${parentId}, ${unit === null ? null : "tiempo"}, ${unit}) returning id`;
  return row.id;
}

// A holder G with one open goal inside, and a plan task of its own already fixed to a month.
async function holder(tag: string, unit: string | null = "minutos") {
  const G = await mk(`868 ${tag} G`, null, unit);
  const child = await mk(`868 ${tag} hija`, G, unit);
  return { G, child };
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  roadmap = await import("@/app/actions/roadmap");
  budgets = await import("@/app/actions/budgets");
  oneOffs = await import("@/app/actions/one-offs");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const made = await plan.createGoal({ name: "868 fixture: raíz", horizon: horizonAt(8) });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${made.goalId}`;
  userId = owner.user_id;
});

after(async () => {
  await sql`delete from goals.one_offs where user_id = ${userId} and goal_id in (select id from goals.goals where name like '868 %')`;
  await sql`update goals.goals set parent_id = null where user_id = ${userId} and name like '868 %'`;
  await sql`delete from goals.goals where user_id = ${userId} and name like '868 %'`;
  await sql.end();
});

test("setRhythm of a goal holding goals is holderNoRhythm and the rhythm stays null", async () => {
  const { G } = await holder("ritmo");
  const result = await roadmap.setRhythm({ goalId: G, amount: 5 });
  assert.deepEqual(result, { ok: false, error: "tree.errors.holderNoRhythm" });
  const [row] = await sql<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${G}`;
  assert.equal(row.rhythm, null);
});

test("setRhythm of a goal whose goals are all archived behaves as a lone goal", async () => {
  const { G, child } = await holder("ritmo-archivada");
  await sql`update goals.goals set archived_at = now() where id = ${child}`;
  assert.deepEqual(await roadmap.setRhythm({ goalId: G, amount: 5 }), { ok: true });
  const [row] = await sql<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${G}`;
  assert.equal(row.rhythm, 5);
});

test("setMonthBudget of a goal holding goals is holderNoBudget and writes no row", async () => {
  const { G } = await holder("monto");
  const result = await budgets.setMonthBudget({ goalId: G, month: monthFrom(today, 2), amount: 10 });
  assert.deepEqual(result, { ok: false, error: "tree.errors.holderNoBudget" });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.month_budgets where goal_id = ${G}`;
  assert.equal(n, 0);
});

test("setMonthBudget of a lone goal still writes, and removeMonthBudget of a holder is allowed", async () => {
  const lone = await mk("868 monto sola");
  assert.deepEqual(await budgets.setMonthBudget({ goalId: lone, month: monthFrom(today, 2), amount: 10 }), { ok: true });
  const { G } = await holder("quitar");
  assert.deepEqual(await budgets.removeMonthBudget({ goalId: G, month: monthFrom(today, 2) }), { ok: true });
});

test("createOneOff of a goal holding goals, with no day, fixes the task to the current month", async () => {
  const { G } = await holder("tarea");
  const result = await oneOffs.createOneOff({ goalId: G, name: "868 tarea fija", day: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [row] = await sql<{ planned_month: string | null; in_plan: boolean }[]>`
    select planned_month::text as planned_month, in_plan from goals.one_offs where id = ${result.oneOffId}`;
  assert.equal(row.planned_month, `${today.slice(0, 7)}-01`);
  assert.equal(row.in_plan, true);
});

test("createOneOff of a goal holding goals fixes the named month", async () => {
  const { G } = await holder("tarea-mes");
  const month = monthFrom(today, 2);
  const result = await oneOffs.createOneOff({ goalId: G, name: "868 tarea mes", day: null, plannedMonth: month, inPlan: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [row] = await sql<{ planned_month: string | null }[]>`
    select planned_month::text as planned_month from goals.one_offs where id = ${result.oneOffId}`;
  assert.equal(row.planned_month, `${month}-01`);
});

test("fixTask month null on a task of a goal holding goals is holderTaskFixed and the month stays", async () => {
  const { G } = await holder("devolver");
  const made = await oneOffs.createOneOff({ goalId: G, name: "868 devolver tarea", day: null });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  const result = await oneOffs.fixTask({ oneOffId: made.oneOffId, month: null });
  assert.deepEqual(result, { ok: false, error: "tree.errors.holderTaskFixed" });
  const [row] = await sql<{ planned_month: string | null }[]>`
    select planned_month::text as planned_month from goals.one_offs where id = ${made.oneOffId}`;
  assert.equal(row.planned_month, `${today.slice(0, 7)}-01`);
});

test("fixTask month null on a task of a lone goal still returns it to the plan", async () => {
  const lone = await mk("868 devolver sola");
  const [row] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, in_plan)
    values (${userId}, ${lone}, '868 tarea sola', ${`${today.slice(0, 7)}-01`}, true) returning id`;
  assert.deepEqual(await oneOffs.fixTask({ oneOffId: row.id, month: null }), { ok: true });
});
