// Drives `deleteOneOff`'s three refusals (`app/actions/one-offs.ts`, RP-22,
// RP-30): a parent with a done sub-task, a leaf with its own fact, and a
// parent with nothing done. Same harness as `task-actions.ts`.
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
    return originalLoad(request, parent, isMain);
  };
}

type Actions = typeof import("@/app/actions/one-offs");
let actions: Actions;
let pgCode: typeof import("@/lib/db-error").pgCode;

// A throw names its SQLSTATE: a refusal the policy made instead of the action
// dies 42501, and the bare "Failed query" drizzle prints never says so.
async function call<K extends "createOneOff" | "completeOneOff" | "scheduleOneOff" | "deleteOneOff">(
  name: K,
  input: Parameters<Actions[K]>[0],
): Promise<Awaited<ReturnType<Actions[K]>>> {
  try {
    const action = actions[name] as (input: Parameters<Actions[K]>[0]) => ReturnType<Actions[K]>;
    return await action(input);
  } catch (error) {
    assert.fail(`${name} threw ${pgCode(error) ?? "without a code"}`);
  }
}

async function created(input: Parameters<Actions["createOneOff"]>[0]): Promise<string> {
  const result = await call("createOneOff", input);
  if (!result.ok) throw new Error(`createOneOff ${input.name}: ${result.error}`);
  return result.oneOffId;
}

// "YYYY-MM" `delta` months from the one `day` sits in.
function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

const goalIds: string[] = [];
let thisMonth: string;
let goalId: string;

async function exists(oneOffId: string): Promise<boolean> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.one_offs where id = ${oneOffId}`;
  return count === 1;
}

async function factsOf(oneOffId: string): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from goals.facts where one_off_id = ${oneOffId}`;
  return count;
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  ({ pgCode } = await import("@/lib/db-error"));
  const { todayInZone } = await import("@/lib/zone");
  const today = todayInZone();
  thisMonth = today.slice(0, 7);
  const horizon = `${monthFrom(today, 2)}-01`;
  const made = await plan.createGoal({ name: "RP-22 fixture: borrar padre", horizon });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
  const commitment = await plan.addCommitment({
    goalId,
    name: "RP-22 fixture: minutos",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 10,
    unit: "minutos",
  });
  if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("a parent with a done sub-task answers parentHasDoneChild; both rows and the fact survive", async () => {
  const parentId = await created({ name: "RP-22 padre hecho", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-22 hija hecha", day: null, parentId });
  const done = await call("completeOneOff", { oneOffId: childId });
  assert.equal(done.ok, true, JSON.stringify(done));

  assert.deepEqual(await call("deleteOneOff", { oneOffId: parentId }), {
    ok: false,
    error: "month.errors.parentHasDoneChild",
  });
  assert.ok((await exists(parentId)) && (await exists(childId)));
  assert.equal(await factsOf(childId), 1);
});

test("a parent with no done sub-task is deleted with its children", async () => {
  const parentId = await created({ name: "RP-22 padre limpio", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-22 hija pendiente", day: null, parentId });
  assert.deepEqual(await call("deleteOneOff", { oneOffId: parentId }), { ok: true });
  assert.ok(!(await exists(parentId)) && !(await exists(childId)));
});

test("a leaf with its own fact answers oneOffHasFact and stays", async () => {
  const leafId = await created({ name: "RP-22 hoja hecha", day: null, goalId, plannedMonth: thisMonth });
  const done = await call("completeOneOff", { oneOffId: leafId });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(await call("deleteOneOff", { oneOffId: leafId }), { ok: false, error: "day.errors.oneOffHasFact" });
  assert.ok(await exists(leafId));
  assert.equal(await factsOf(leafId), 1);
});
