// Drives `editHabit` (`app/actions/plan.ts`, RP-104) on loose habits: name and note change in one
// statement and nothing else moves; a goal's commitment, another person's and a missing id are not
// found; a retired habit is refused habitRetired. `server-only`, `next/headers` and `next/cache` are
// stubbed; each row the test makes is deleted by its own id.
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
let standing: StoredCookie[] = [];

type PostgresFactory = (url: string, options: Record<string, unknown>) => unknown;

function installStubs(cookies: StoredCookie[]): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => standing, set() {} }) };
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


let editHabit: typeof import("@/app/actions/plan").editHabit;
let createGoal: typeof import("@/app/actions/plan").createGoal;
let sessionCookies: StoredCookie[];

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const commitmentIds: string[] = [];
const goalIds: string[] = [];
let me: string;

type Row = Record<string, unknown>;

async function rowOf(id: string): Promise<Row> {
  const [row] = await sql<Row[]>`
    select name, note, cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit,
           threshold, created_at, position, retired_at, goal_id
    from goals.commitments where id = ${id}`;
  return row;
}

async function factCount(id: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from goals.facts where commitment_id = ${id}`;
  return row.n;
}

async function habit(name: string, extra = sql`null`): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit, note)
    values (${me}, ${name}, 'times_per_week', 3, 'quantity', 30, 'minutos', ${extra}) returning id`;
  commitmentIds.push(row.id);
  return row.id;
}

before(async () => {
  sessionCookies = loadCookies();
  standing = sessionCookies;
  installStubs(sessionCookies);
  const plan = await import("@/app/actions/plan");
  editHabit = plan.editHabit;
  createGoal = plan.createGoal;
  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("the lane's session carries no person");
  me = person.id;
});

after(async () => {
  try {
    if (commitmentIds.length > 0) await sql`delete from goals.commitments where id in ${sql(commitmentIds)}`;
    if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  } finally {
    await sql.end();
  }
});

test("editHabit: name and note change in one statement; cadence, quantity, created_at, position and facts stay", async () => {
  const id = await habit("RP-104 original", sql`'nota vieja'`);
  await sql`insert into goals.facts (user_id, commitment_id, day, quantity) values (${me}, ${id}, '2026-01-05', 10)`;
  const before = await rowOf(id);
  revalidated.length = 0;
  wire = [];
  const result = await editHabit({ commitmentId: id, name: "  RP-104 nuevo ", note: " nota nueva " });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase());
  wire = null;
  assert.deepEqual(result, { ok: true });
  const statements = calls.filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type") && !q.includes("set_config("));
  assert.equal(statements.length, 1, statements.join(" | "));
  const after = await rowOf(id);
  assert.equal(after.name, "RP-104 nuevo");
  assert.equal(after.note, "nota nueva");
  const { name: _n, note: _o, ...restBefore } = before;
  const { name: _n2, note: _o2, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore);
  assert.equal(await factCount(id), 1);
  for (const path of ["/", "/semana", "/mes", "/metas", `/metas/habitos/${id}`]) {
    assert.ok(revalidated.includes(path), `${path} not revalidated: ${revalidated.join(", ")}`);
  }
});

test("editHabit: an empty note clears it to null", async () => {
  const id = await habit("RP-104 con nota", sql`'algo'`);
  assert.deepEqual(await editHabit({ commitmentId: id, name: "RP-104 con nota", note: "" }), { ok: true });
  assert.equal((await rowOf(id)).note, null);
});

test("editHabit: a goal's commitment is not found and keeps its name", async () => {
  const made = await createGoal({ name: "RP-104 fixture: meta", horizon: "2099-01-01" });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  const [row] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${me}, ${made.goalId}, 'RP-104 de meta', 'daily', 'tap') returning id`;
  assert.deepEqual(await editHabit({ commitmentId: row.id, name: "robado", note: "x" }), {
    ok: false,
    error: "plan.errors.notFound",
  });
  assert.equal((await rowOf(row.id)).name, "RP-104 de meta");
});

test("editHabit: another person's habit is not found and keeps its name", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, name, cadence_kind, satisfaction)
    values (${member.id}, 'RP-104 ajeno', 'daily', 'tap') returning id`;
  try {
    assert.deepEqual(await editHabit({ commitmentId: foreign.id, name: "robado", note: "x" }), {
      ok: false,
      error: "plan.errors.notFound",
    });
    assert.equal((await rowOf(foreign.id)).name, "RP-104 ajeno");
  } finally {
    await sql`delete from goals.commitments where id = ${foreign.id} and user_id = ${member.id}`;
  }
});

test("editHabit: a missing id is not found", async () => {
  assert.deepEqual(
    await editHabit({ commitmentId: "00000000-0000-4000-8000-000000000104", name: "x", note: "" }),
    { ok: false, error: "plan.errors.notFound" },
  );
});

test("editHabit: a retired habit is refused habitRetired and keeps its name and note", async () => {
  const id = await habit("RP-104 retirado", sql`'queda'`);
  await sql`update goals.commitments set retired_at = now() where id = ${id}`;
  assert.deepEqual(await editHabit({ commitmentId: id, name: "otro", note: "otra" }), {
    ok: false,
    error: "plan.errors.habitRetired",
  });
  const row = await rowOf(id);
  assert.equal(row.name, "RP-104 retirado");
  assert.equal(row.note, "queda");
});

test("editHabit: signed out answers signedOut and writes nothing", async () => {
  const id = await habit("RP-104 sin sesión");
  standing = [];
  const out = await editHabit({ commitmentId: id, name: "cambiado", note: "x" });
  standing = sessionCookies;
  assert.deepEqual(out, { ok: false, error: "plan.errors.signedOut" });
  assert.equal((await rowOf(id)).name, "RP-104 sin sesión");
});
