// Drives `editTask` (`app/actions/one-offs.ts`, RP-55) on a goal's own dated
// one-off, the one that is not in the plan: its name alone is accepted, done
// or not; an estimate or a month is refused `invalid`; another person's row
// is not found. Wired like `edit-task.ts`: the action imported as a plain
// async function with `server-only`, `next/headers` and `next/cache` stubbed.
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

async function edit(input: Parameters<Actions["editTask"]>[0]) {
  try {
    return await actions.editTask(input);
  } catch (error) {
    assert.fail(`editTask threw ${pgCode(error) ?? "without a code"}`);
  }
}

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
let goalId: string;

async function rowOf(id: string) {
  const [row] = await sql<{ name: string; estimate: number | null; planned_month: string | null; in_plan: boolean }[]>`
    select name, estimate, planned_month::text as planned_month, in_plan from goals.one_offs where id = ${id}`;
  return row;
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  createGoal = plan.createGoal;
  ({ pgCode } = await import("@/lib/db-error"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const made = await createGoal({ name: "RP-55 fixture: de meta", horizon: `${monthFrom(today, 2)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
  await sql`update goals.goals set measure_name = 'horas', measure_unit = 'minutos' where id = ${goalId}`;
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

async function dated(name: string): Promise<string> {
  const result = await actions.createOneOff({ name, day: today, goalId });
  if (!result.ok) throw new Error(`createOneOff ${name}: ${result.error}`);
  return result.oneOffId;
}

test("editTask: a goal's dated one-off outside the plan takes a new name in one statement, done or not", async () => {
  const id = await dated("RP-55 fechada");
  assert.equal((await rowOf(id)).in_plan, false);
  wire = [];
  const result = await edit({ oneOffId: id, name: "RP-55 fechada, renombrada" });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase());
  wire = null;
  assert.deepEqual(result, { ok: true });
  const statements = calls.filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type") && !q.includes("set_config("));
  assert.equal(statements.length, 1, statements.join(" | "));
  assert.equal((await rowOf(id)).name, "RP-55 fechada, renombrada");

  assert.equal((await actions.completeOneOff({ oneOffId: id })).ok, true);
  assert.deepEqual(await edit({ oneOffId: id, name: "RP-55 fechada, hecha" }), { ok: true });
  assert.deepEqual(await rowOf(id), { name: "RP-55 fechada, hecha", estimate: null, planned_month: null, in_plan: false });
});

test("editTask: the same one-off with an estimate or a month is refused invalid and nothing changes", async () => {
  const id = await dated("RP-55 sin plan");
  const before = await rowOf(id);
  assert.deepEqual(await edit({ oneOffId: id, name: "otra", estimate: 30 }), { ok: false, error: "month.errors.invalid" });
  assert.deepEqual(await edit({ oneOffId: id, name: "otra", month: monthFrom(today, 1) }), { ok: false, error: "month.errors.invalid" });
  assert.deepEqual(await edit({ oneOffId: id, name: "otra", month: null }), { ok: false, error: "month.errors.invalid" });
  assert.deepEqual(await rowOf(id), before);
});

test("editTask: another person's goal one-off is not found and keeps its name, through the policy", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");

  const [foreignGoal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-55 ajena', ${`${monthFrom(today, 2)}-01`}) returning id`;
  try {
    const [foreign] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, day, in_plan)
      values (${member.id}, ${foreignGoal.id}, 'RP-55 ajena fechada', ${today}, false) returning id`;
    assert.deepEqual(await edit({ oneOffId: foreign.id, name: "robada" }), { ok: false, error: "plan.errors.notFound" });
    assert.equal((await rowOf(foreign.id)).name, "RP-55 ajena fechada");
  } finally {
    await sql`delete from goals.goals where id = ${foreignGoal.id} and user_id = ${member.id}`;
  }
});
