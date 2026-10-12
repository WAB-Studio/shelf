// Drives `setGoalNote` (`app/actions/plan.ts`, RP-95) as a plain async function, wired like
// `tree-actions.ts`: the lane's minted session is the caller, a goal of another person the
// foreign row, every fixture deleted by its exact id.
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

type Plan = typeof import("@/app/actions/plan");
let plan: Plan;

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

type Row = { name: string; horizon: string; parent_id: string | null; archived_at: string | null; position: number; rhythm: number | null; note: string | null };
async function rowOf(id: string): Promise<Row> {
  const [row] = await sql<Row[]>`
    select name, horizon::text as horizon, parent_id, archived_at::text as archived_at, position, rhythm, note
    from goals.goals where id = ${id}`;
  return row;
}

before(async () => {
  installStubs(loadCookies());
  plan = await import("@/app/actions/plan");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const made = await plan.createGoal({ name: "RP-95 fixture: nota", horizon: `${monthFrom(today, 3)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("setGoalNote: three lines are kept with their line breaks, in one statement, and no other column moves", async () => {
  const before = await rowOf(goalId);
  wire = [];
  const result = await plan.setGoalNote({ goalId, note: "  uno\ndos\ntres \n" });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase()).filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type"));
  wire = null;
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2, calls.join(" | "));
  assert.deepEqual(await rowOf(goalId), { ...before, note: "uno\ndos\ntres" });
  assert.ok(revalidated.includes(`/metas/${goalId}`));
});

test("setGoalNote: a blank note clears it to null, never an empty string", async () => {
  assert.deepEqual(await plan.setGoalNote({ goalId, note: "algo" }), { ok: true });
  assert.deepEqual(await plan.setGoalNote({ goalId, note: "  \n " }), { ok: true });
  assert.equal((await rowOf(goalId)).note, null);
});

test("setGoalNote: 20000 characters are kept, 20001 are noteTooLong and the note stays", async () => {
  assert.deepEqual(await plan.setGoalNote({ goalId, note: "x".repeat(20000) }), { ok: true });
  assert.equal((await rowOf(goalId)).note?.length, 20000);
  assert.deepEqual(await plan.setGoalNote({ goalId, note: "y".repeat(20001) }), { ok: false, error: "tree.errors.noteTooLong" });
  assert.equal((await rowOf(goalId)).note?.length, 20000);
});

test("setGoalNote: another person's goal is not found and keeps its note", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, note)
    values (${member.id}, 'RP-95 ajena', ${`${monthFrom(today, 3)}-01`}, 'de otra') returning id`;
  try {
    assert.deepEqual(await plan.setGoalNote({ goalId: foreign.id, note: "robada" }), { ok: false, error: "plan.errors.notFound" });
    assert.equal((await rowOf(foreign.id)).note, "de otra");
  } finally {
    await sql`delete from goals.goals where id = ${foreign.id} and user_id = ${member.id}`;
  }
});
