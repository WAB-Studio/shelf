// Drives `setOneOffNote` and `createOneOff`'s note (`app/actions/one-offs.ts`, RP-45) the way
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

async function setNote(input: Parameters<Actions["setOneOffNote"]>[0]) {
  try {
    return await actions.setOneOffNote(input);
  } catch (error) {
    assert.fail(`setOneOffNote threw ${pgCode(error) ?? "without a code"}`);
  }
}

async function created(input: Parameters<Actions["createOneOff"]>[0]): Promise<string> {
  const result = await actions.createOneOff(input);
  if (!result.ok) throw new Error(`createOneOff ${input.name}: ${result.error}`);
  return result.oneOffId;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, {
  prepare: false,
  max: 1,
  connection: { statement_timeout: 15_000, lock_timeout: 10_000 },
});

const goalIds: string[] = [];
let goalId: string;
let thisMonth: string;

async function noteOf(id: string): Promise<string | null | undefined> {
  const [row] = await sql<{ note: string | null }[]>`select note from goals.one_offs where id = ${id}`;
  return row?.note;
}

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  actions = await import("@/app/actions/one-offs");
  createGoal = plan.createGoal;
  ({ pgCode } = await import("@/lib/db-error"));
  const { todayInZone } = await import("@/lib/zone");
  thisMonth = todayInZone().slice(0, 7);
  const made = await createGoal({ name: "RP-45 fixture: nota", horizon: "2099-12-01" });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
  goalIds.push(goalId);
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("setOneOffNote: a note is written, changed and emptied to null, never to an empty string, in one statement", async () => {
  const id = await created({ name: "RP-45 nota", day: null });
  revalidated.length = 0;
  wire = [];
  const written = await setNote({ oneOffId: id, note: "  primera\r\nsegunda  " });
  const calls = (wire as string[]).map((q) => q.trim().toLowerCase());
  wire = null;
  assert.deepEqual(written, { ok: true });
  const statements = calls.filter(
    (q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type") && !q.includes("set_config"),
  );
  assert.equal(statements.length, 1, calls.join(" | "));
  assert.match(statements[0], /^update /);
  assert.equal(await noteOf(id), "primera\nsegunda");
  for (const route of ["/", "/sueltas", "/mes", "/metas", "/exportar"]) {
    assert.ok(revalidated.includes(route), `${route} revalidated`);
  }

  assert.deepEqual(await setNote({ oneOffId: id, note: "otra" }), { ok: true });
  assert.equal(await noteOf(id), "otra");

  for (const blank of ["", "  \n ", null]) {
    assert.deepEqual(await setNote({ oneOffId: id, note: blank }), { ok: true });
    assert.equal(await noteOf(id), null, JSON.stringify(blank));
    await setNote({ oneOffId: id, note: "de nuevo" });
  }
});

test("setOneOffNote: 2000 characters are stored, 2001 are refused with the key and the note stays", async () => {
  const id = await created({ name: "RP-45 larga", day: null });
  assert.deepEqual(await setNote({ oneOffId: id, note: "a".repeat(2000) }), { ok: true });
  assert.equal((await noteOf(id))?.length, 2000);
  assert.deepEqual(await setNote({ oneOffId: id, note: "b".repeat(2001) }), {
    ok: false,
    error: "day.errors.oneOffNoteTooLong",
  });
  assert.equal((await noteOf(id))?.length, 2000);
});

test("setOneOffNote: a done task takes a note and reads it back; a single UPDATE of note and day on it writes 0 rows", async () => {
  const id = await created({ name: "RP-45 hecha", day: null, goalId, plannedMonth: thisMonth });
  const completed = await actions.completeOneOff({ oneOffId: id });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const [{ day: doneDay }] = await sql<{ day: string | null }[]>`select day::text as day from goals.one_offs where id = ${id}`;

  assert.deepEqual(await setNote({ oneOffId: id, note: "hecha y anotada" }), { ok: true });
  assert.equal(await noteOf(id), "hecha y anotada");

  // The trigger skips the whole row: the note rides nowhere when `day` moves too.
  const touched = await sql`update goals.one_offs set note = 'con día', day = '2099-01-01' where id = ${id}`;
  assert.equal(touched.count, 0);
  assert.equal(await noteOf(id), "hecha y anotada");
  const [after] = await sql<{ day: string | null }[]>`select day::text as day from goals.one_offs where id = ${id}`;
  assert.equal(after.day, doneDay);

  // The act names `note` alone, so the same row takes it again.
  assert.deepEqual(await setNote({ oneOffId: id, note: "otra vez" }), { ok: true });
  assert.equal(await noteOf(id), "otra vez");
  const [still] = await sql<{ day: string | null }[]>`select day::text as day from goals.one_offs where id = ${id}`;
  assert.equal(still.day, doneDay);
});

test("setOneOffNote: another person's one-off is not found and its note is unchanged; an id that is nobody's too", async () => {
  const lane = laneNumber();
  const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");

  const [foreignGoal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-45 ajena', '2099-12-01') returning id`;
  try {
    const [foreign] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, note)
      values (${member.id}, ${foreignGoal.id}, 'RP-45 tarea ajena', 'de ella') returning id`;
    assert.deepEqual(await setNote({ oneOffId: foreign.id, note: "mía" }), { ok: false, error: "day.errors.notFound" });
    assert.equal(await noteOf(foreign.id), "de ella");
  } finally {
    await sql`delete from goals.goals where id = ${foreignGoal.id} and user_id = ${member.id}`;
  }
  const nobody = await setNote({ oneOffId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", note: "x" });
  assert.deepEqual(nobody, { ok: false, error: "day.errors.notFound" });
});

test("createOneOff: a note is stored trimmed, a blank one is no note, and a note on a sub-task is kept", async () => {
  const withNote = await created({ name: "RP-45 con nota", day: null, note: "  recordar\r\nllamar " });
  assert.equal(await noteOf(withNote), "recordar\nllamar");
  const blank = await created({ name: "RP-45 nota vacía", day: null, note: "   " });
  assert.equal(await noteOf(blank), null);
  const none = await created({ name: "RP-45 sin nota", day: null });
  assert.equal(await noteOf(none), null);

  const parentId = await created({ name: "RP-45 padre", day: null, goalId, plannedMonth: thisMonth });
  const childId = await created({ name: "RP-45 hija", day: null, parentId, note: "de la hija" });
  assert.equal(await noteOf(childId), "de la hija");

  const long = await actions.createOneOff({ name: "RP-45 larga", day: null, note: "c".repeat(2001) });
  assert.deepEqual(long, { ok: false, error: "day.errors.oneOffNoteTooLong" });
});
