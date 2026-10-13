// Drives the goal tree's acts (`app/actions/plan.ts`, RP-79, RP-82, RP-83, RP-95) as plain async
// functions, wired like `rename-goal-one-off.ts`: `server-only`, `next/headers` and `next/cache`
// stubbed, the lane's minted session as the caller. Fixture goals are inserted straight through
// the owner connection; every refusal is read back as rows that did not move.
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

const rootIds: string[] = [];
let today: string;
let userId: string;
const horizonAt = (months: number) => `${monthFrom(today, months)}-01`;

// A goal inserted as the owner; the tree's triggers still judge it.
async function mk(name: string, months: number, parentId: string | null = null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id)
    values (${userId}, ${name}, ${horizonAt(months)}, ${parentId}) returning id`;
  if (parentId === null) rootIds.push(row.id);
  return row.id;
}

type Row = { parent_id: string | null; archived_at: string | null; position: number; horizon: string };
async function rowOf(id: string): Promise<Row> {
  const [row] = await sql<Row[]>`
    select parent_id, archived_at::text as archived_at, position, horizon::text as horizon from goals.goals where id = ${id}`;
  return row;
}

function statements(calls: string[]): string[] {
  return calls
    .map((q) => q.trim().toLowerCase())
    .filter((q) => q !== "begin" && q !== "commit" && !q.includes("pg_catalog.pg_type"));
}

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  wire = [];
  const result = await run();
  const calls = statements(wire);
  wire = null;
  return { result, calls };
}

before(async () => {
  installStubs(loadCookies());
  plan = await import("@/app/actions/plan");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const made = await plan.createGoal({ name: "867 fixture: raíz", horizon: horizonAt(8) });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  rootIds.push(made.goalId);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${made.goalId}`;
  userId = owner.user_id;
});

after(async () => {
  if (rootIds.length > 0) {
    // Children first: the foreign key has no cascade.
    await sql`update goals.goals set parent_id = null where user_id = ${userId} and name like '867 %'`;
    await sql`delete from goals.goals where user_id = ${userId} and name like '867 %'`;
  }
  await sql.end();
});

async function tree(tag: string) {
  const G = await mk(`867 ${tag} G`, 7);
  const g1 = await mk(`867 ${tag} g1`, 6, G);
  const p = await mk(`867 ${tag} p`, 5, g1);
  const g2 = await mk(`867 ${tag} g2`, 6, G);
  return { G, g1, p, g2 };
}

test("createGoal inside a goal: the row carries parent_id, in at most five statements, and revalidates the tree's screens", async () => {
  const { G } = await tree("crear");
  const above = await mk("867 crear libre", 7);
  revalidated.length = 0;
  const { result, calls } = await counted(() => plan.createGoal({ name: "867 crear hija", horizon: horizonAt(6), parentId: above }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((await rowOf(result.goalId)).parent_id, above);
  assert.ok(calls.length <= 5, calls.join(" | "));
  for (const path of ["/", "/metas", "/mes", "/exportar", `/metas/${above}`, `/metas/${result.goalId}`]) {
    assert.ok(revalidated.includes(path), `${path} not revalidated: ${revalidated.join(",")}`);
  }
  assert.equal((await rowOf(G)).parent_id, null);
});

test("createGoal inside a small goal is tooDeep and writes no row", async () => {
  const { p } = await tree("hondo");
  const result = await plan.createGoal({ name: "867 hondo nueva", horizon: horizonAt(4), parentId: p });
  assert.deepEqual(result, { ok: false, error: "tree.errors.tooDeep" });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.goals where name = '867 hondo nueva'`;
  assert.equal(n, 0);
});

test("createGoal ending past the goal above is endPastAbove and names that goal", async () => {
  const { g1 } = await tree("final");
  const result = await plan.createGoal({ name: "867 final nueva", horizon: horizonAt(7), parentId: g1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "tree.errors.endPastAbove");
  assert.equal(result.values?.name, "867 final g1");
  // g1 ends the first day of month +6: its last day is the one before.
  const [y, m] = monthFrom(today, 6).split("-").map(Number);
  assert.equal(result.values?.date, new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10));
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.goals where name = '867 final nueva'`;
  assert.equal(n, 0);
});

test("createGoal inside an archived goal is aboveClosed with its name and writes no row", async () => {
  const { g2 } = await tree("cerrada");
  await sql`update goals.goals set archived_at = now() where id = ${g2}`;
  const result = await plan.createGoal({ name: "867 cerrada nueva", horizon: horizonAt(4), parentId: g2 });
  assert.deepEqual(result, { ok: false, error: "tree.errors.aboveClosed", values: { name: "867 cerrada g2" } });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.goals where name = '867 cerrada nueva'`;
  assert.equal(n, 0);
});

test("moveGoal writes parent_id alone: under another goal, then back to the top", async () => {
  const { p, g2, g1 } = await tree("mover");
  const before = await rowOf(p);
  const { result, calls } = await counted(() => plan.moveGoal({ goalId: p, parentId: g2 }));
  assert.deepEqual(result, { ok: true });
  assert.ok(calls.length <= 5, calls.join(" | "));
  assert.deepEqual(await rowOf(p), { ...before, parent_id: g2 });
  assert.deepEqual(await plan.moveGoal({ goalId: p, parentId: null }), { ok: true });
  assert.deepEqual(await rowOf(p), { ...before, parent_id: null });
  assert.equal((await rowOf(g1)).parent_id !== null, true);
});

test("moveGoal into its own branch is a cycle and nothing changes", async () => {
  const { G, p } = await tree("ciclo");
  const before = [await rowOf(G), await rowOf(p)];
  assert.deepEqual(await plan.moveGoal({ goalId: G, parentId: p }), { ok: false, error: "tree.errors.cycle" });
  assert.deepEqual([await rowOf(G), await rowOf(p)], before);
});

test("moveGoal of another person's goal, or under one, is not found and nothing of theirs or mine moves", async () => {
  const lane = laneNumber();
  const [member] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${`harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`}`;
  if (!member) throw new Error("no lane identities — run harness:token for this lane");
  const mine = await mk("867 ajena mía", 5);
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${member.id}, '867 ajena de otra', ${horizonAt(5)}) returning id`;
  try {
    const notFound = { ok: false, error: "tree.errors.notFound" };
    assert.deepEqual(await plan.moveGoal({ goalId: foreign.id, parentId: mine }), notFound);
    assert.deepEqual(await plan.moveGoal({ goalId: mine, parentId: foreign.id }), notFound);
    assert.equal((await rowOf(mine)).parent_id, null);
    assert.equal((await rowOf(foreign.id)).parent_id, null);
  } finally {
    await sql`delete from goals.goals where id = ${foreign.id} and user_id = ${member.id}`;
  }
});

test("two moves that together would make four levels: one is refused, the tree stays at three", async () => {
  const a = await mk("867 carrera a", 7);
  const b = await mk("867 carrera b", 6, a);
  const c = await mk("867 carrera c", 5);
  const d = await mk("867 carrera d", 4);
  // The person's lock is held here while both moves start, so both are in flight at once: a move
  // that does not queue behind it is caught below.
  const holder = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  const held = holder.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${userId}::text, 1))`;
    locked();
    await gate;
  });
  await taken;
  const pending = Promise.all([
    plan.moveGoal({ goalId: c, parentId: b }),
    plan.moveGoal({ goalId: d, parentId: c }),
  ]);
  let queued = 0;
  try {
    for (let i = 0; i < 100 && queued < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      [{ queued }] = await sql<{ queued: number }[]>`
        select count(*)::int as queued from pg_locks where locktype = 'advisory' and not granted`;
    }
  } finally {
    release();
    await held;
    await holder.end();
  }
  const outcomes = await pending;
  assert.ok(queued >= 2, "both moves wait for the person's lock");
  assert.equal(outcomes.filter((r) => r.ok).length, 1, JSON.stringify(outcomes));
  const refused = outcomes.find((r) => !r.ok);
  assert.equal(refused && !refused.ok && refused.error, "tree.errors.tooDeep");
  const [{ levels }] = await sql<{ levels: number }[]>`
    with recursive up(id, n) as (
      select id, 1 from goals.goals where id = ${d}
      union all select g.parent_id, up.n + 1 from goals.goals g join up on g.id = up.id where g.parent_id is not null
    ) select max(n)::int as levels from up`;
  assert.ok(levels <= 3, `${levels} levels`);
});

test("archiveGoal archives the whole branch in one write with one instant", async () => {
  const { G, g1, p, g2 } = await tree("archivar");
  const { result, calls } = await counted(() => plan.archiveGoal({ goalId: G }));
  assert.deepEqual(result, { ok: true, archived: 4 });
  assert.equal(calls.length, 2, calls.join(" | "));
  const rows = await sql<{ n: number }[]>`
    select count(distinct archived_at)::int as n from goals.goals where id in ${sql([G, g1, p, g2])} and archived_at is not null`;
  assert.equal(rows[0].n, 1);
  const [{ k }] = await sql<{ k: number }[]>`select count(*)::int as k from goals.goals where id in ${sql([G, g1, p, g2])} and archived_at is not null`;
  assert.equal(k, 4);
});

test("reopenGoal reopens the branch archived with it and leaves one archived before, alone", async () => {
  const { G, g1, p, g2 } = await tree("reabrir");
  await sql`update goals.goals set archived_at = now() - interval '2 hours' where id = ${g2}`;
  assert.deepEqual(await plan.archiveGoal({ goalId: G }), { ok: true, archived: 3 });
  const { result, calls } = await counted(() => plan.reopenGoal({ goalId: G }));
  assert.deepEqual(result, { ok: true, reopened: 3 });
  assert.equal(calls.length, 2, calls.join(" | "));
  for (const id of [G, g1, p]) assert.equal((await rowOf(id)).archived_at, null);
  assert.notEqual((await rowOf(g2)).archived_at, null);
});

test("reopenGoal of a goal under an archived one is aboveArchived with that goal's name", async () => {
  const { G, g1 } = await tree("bajo");
  assert.equal((await plan.archiveGoal({ goalId: G })).ok, true);
  const result = await plan.reopenGoal({ goalId: g1 });
  assert.deepEqual(result, { ok: false, error: "tree.errors.aboveArchived", values: { name: "867 bajo G" } });
  assert.notEqual((await rowOf(g1)).archived_at, null);
});

test("moveHorizon before a goal inside ends later is belowEndsLater; after the goal above, endPastAbove", async () => {
  const { G, g1, g2 } = await tree("final2");
  const before = await rowOf(G);
  const early = await plan.moveHorizon({ goalId: G, horizon: horizonAt(3) });
  assert.equal(early.ok, false);
  if (early.ok) return;
  assert.equal(early.error, "tree.errors.belowEndsLater");
  assert.ok(early.values?.name === "867 final2 g1" || early.values?.name === "867 final2 g2", early.values?.name);
  assert.deepEqual(await rowOf(G), before);

  const late = await plan.moveHorizon({ goalId: g1, horizon: horizonAt(8) });
  assert.equal(late.ok, false);
  if (late.ok) return;
  assert.equal(late.error, "tree.errors.endPastAbove");
  assert.equal(late.values?.name, "867 final2 G");
  assert.equal((await rowOf(g2)).horizon, horizonAt(6));
});

test("a goal with a stored rhythm that receives a goal has its planned tasks fixed to the month the plan gave them", async () => {
  const opened = `${monthFrom(today, -2)}-05`;
  const [h] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${userId}, '867 ritmo H', ${horizonAt(8)}, 'horas', 'minutos', 1000, ${opened}) returning id`;
  rootIds.push(h.id);
  const tasks = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, created_at)
    values (${userId}, ${h.id}, '867 tarea 1', 1000, true, ${opened}), (${userId}, ${h.id}, '867 tarea 2', 1000, true, ${opened}) returning id`;
  const { result, calls } = await counted(() => plan.createGoal({ name: "867 ritmo hija", horizon: horizonAt(6), parentId: h.id }));
  assert.equal(result.ok, true);
  // Settle, lock, tree, insert, the measure it inherits, then the plan's read and the one write that fixes.
  assert.equal(calls.length, 7, calls.join(" | "));
  const rows = await sql<{ name: string; planned_month: string | null; in_plan: boolean }[]>`
    select name, planned_month::text as planned_month, in_plan from goals.one_offs where id in ${sql(tasks.map((t) => t.id))} order by name`;
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { name: "867 tarea 1", planned_month: `${monthFrom(today, 0)}-01`, in_plan: true },
    { name: "867 tarea 2", planned_month: `${monthFrom(today, 1)}-01`, in_plan: true },
  ]);
  const [{ rhythm }] = await sql<{ rhythm: number }[]>`select rhythm from goals.goals where id = ${h.id}`;
  assert.equal(rhythm, 1000);
});

test("a tree trigger's 23514 reached through a race names the goal that blocks, with its last day", async () => {
  const G = await mk("867 gatillo G", 7);
  const holder = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  // The row lock stops moveHorizon's UPDATE after its pure checks passed; a child ending later
  // is committed meanwhile, so only the trigger can refuse.
  const held = holder.begin(async (tx) => {
    await tx`select id from goals.goals where id = ${G} for no key update`;
    locked();
    await gate;
  });
  await taken;
  const pending = plan.moveHorizon({ goalId: G, horizon: horizonAt(3) });
  let waiting = 0;
  try {
    for (let i = 0; i < 100 && waiting < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      [{ waiting }] = await sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks where locktype = 'transactionid' and not granted`;
    }
    await mk("867 gatillo hija", 5, G);
  } finally {
    release();
    await held;
    await holder.end();
  }
  assert.ok(waiting >= 1, "the horizon move waits on the goal's row");
  const [y, m] = monthFrom(today, 5).split("-").map(Number);
  assert.deepEqual(await pending, {
    ok: false,
    error: "tree.errors.endPastAbove",
    values: { name: "867 gatillo hija", date: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) },
  });
  assert.equal((await rowOf(G)).horizon, horizonAt(7));
});

test("createGoal inside a goal that has a measure: the new goal measures the same, so its rhythm can add up", async () => {
  const above = await mk("867 medida arriba", 7);
  await sql`update goals.goals set measure_name = 'horas de estudio', measure_unit = 'minutos' where id = ${above}`;
  const result = await plan.createGoal({ name: "867 medida hija", horizon: horizonAt(6), parentId: above });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [child] = await sql<{ measure_name: string | null; measure_unit: string | null }[]>`
    select measure_name, measure_unit from goals.goals where id = ${result.goalId}`;
  assert.deepEqual({ ...child }, { measure_name: "horas de estudio", measure_unit: "minutos" });
});

test("createGoal inside a goal with no measure leaves the new goal with none", async () => {
  const above = await mk("867 sin medida arriba", 7);
  const result = await plan.createGoal({ name: "867 sin medida hija", horizon: horizonAt(6), parentId: above });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [child] = await sql<{ measure_unit: string | null }[]>`select measure_unit from goals.goals where id = ${result.goalId}`;
  assert.equal(child.measure_unit, null);
});

// A goal with a stored rhythm and two planned tasks that no month holds yet, opened two months ago.
async function rhythmHolder(tag: string): Promise<{ id: string; tasks: string[] }> {
  const opened = `${monthFrom(today, -2)}-05`;
  const [h] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${userId}, ${`867 ${tag} H`}, ${horizonAt(8)}, 'horas', 'minutos', 1000, ${opened}) returning id`;
  rootIds.push(h.id);
  const tasks = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, created_at)
    values (${userId}, ${h.id}, ${`867 ${tag} tarea 1`}, 1000, true, ${opened}), (${userId}, ${h.id}, ${`867 ${tag} tarea 2`}, 1000, true, ${opened}) returning id`;
  return { id: h.id, tasks: tasks.map((t) => t.id) };
}

async function plannedMonths(ids: string[]): Promise<(string | null)[]> {
  const rows = await sql<{ planned_month: string | null }[]>`
    select planned_month::text as planned_month from goals.one_offs where id in ${sql(ids)} order by name`;
  return rows.map((row) => row.planned_month);
}

test("moveGoal under a goal with a stored rhythm fixes that goal's planned tasks to the month the plan gave them", async () => {
  const { id: holder, tasks } = await rhythmHolder("mover ritmo");
  const mine = await mk("867 mover ritmo libre", 5);
  assert.deepEqual(await plannedMonths(tasks), [null, null]);
  assert.deepEqual(await plan.moveGoal({ goalId: mine, parentId: holder }), { ok: true });
  assert.deepEqual(await plannedMonths(tasks), [`${monthFrom(today, 0)}-01`, `${monthFrom(today, 1)}-01`]);
});

test("a goal whose goals are all archived is not a holder yet: a new goal in it fixes its planned tasks", async () => {
  const { id: holder, tasks } = await rhythmHolder("archivada");
  const old = await mk("867 archivada vieja", 5, holder);
  await sql`update goals.goals set archived_at = now() where id = ${old}`;
  const made = await plan.createGoal({ name: "867 archivada nueva", horizon: horizonAt(6), parentId: holder });
  assert.equal(made.ok, true);
  assert.deepEqual(await plannedMonths(tasks), [`${monthFrom(today, 0)}-01`, `${monthFrom(today, 1)}-01`]);
});

test("a goal that already holds an open goal fixes nothing when it receives another", async () => {
  const { id: holder, tasks } = await rhythmHolder("segunda");
  // Opening the first goal fixes the tasks; the person then unpins one by hand, and a second goal must not pin it again.
  const first = await plan.createGoal({ name: "867 segunda primera", horizon: horizonAt(6), parentId: holder });
  assert.equal(first.ok, true);
  await sql`update goals.one_offs set planned_month = null where id in ${sql(tasks)}`;
  const second = await plan.createGoal({ name: "867 segunda segunda", horizon: horizonAt(6), parentId: holder });
  assert.equal(second.ok, true);
  assert.deepEqual(await plannedMonths(tasks), [null, null]);
});

test("moveGoal revalidates the goal's screen, the one it left and the one it joined", async () => {
  const { g1, p, g2 } = await tree("revalida mover");
  revalidated.length = 0;
  assert.deepEqual(await plan.moveGoal({ goalId: p, parentId: g2 }), { ok: true });
  for (const id of [p, g1, g2]) assert.ok(revalidated.includes(`/metas/${id}`), `/metas/${id} not revalidated: ${revalidated.join(",")}`);
  for (const path of ["/", "/metas", "/mes", "/exportar"]) assert.ok(revalidated.includes(path), path);
});

test("moveHorizon revalidates the goal's screen, the goal above it and every goal under it", async () => {
  const { G, g1, p } = await tree("revalida final");
  revalidated.length = 0;
  assert.deepEqual(await plan.moveHorizon({ goalId: g1, horizon: horizonAt(5) }), { ok: true });
  for (const id of [g1, G, p]) assert.ok(revalidated.includes(`/metas/${id}`), `/metas/${id} not revalidated: ${revalidated.join(",")}`);
  for (const path of ["/", "/metas", "/mes", "/exportar"]) assert.ok(revalidated.includes(path), path);
});

test("archiveGoal of a goal that is not there, or is another person's, is not found and archives nothing", async () => {
  const lane = laneNumber();
  const [member] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${`harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`}`;
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${member.id}, '867 archivar ajena', ${horizonAt(5)}) returning id`;
  try {
    const notFound = { ok: false, error: "plan.errors.notFound" };
    assert.deepEqual(await plan.archiveGoal({ goalId: randomUUID() }), notFound);
    assert.deepEqual(await plan.archiveGoal({ goalId: foreign.id }), notFound);
    assert.equal((await rowOf(foreign.id)).archived_at, null);
  } finally {
    await sql`delete from goals.goals where id = ${foreign.id} and user_id = ${member.id}`;
  }
});

test("reopenGoal under a branch archived with it names the goal right above, not the one at the top", async () => {
  const { G, g1, p } = await tree("bajo cercana");
  assert.equal((await plan.archiveGoal({ goalId: G })).ok, true);
  const result = await plan.reopenGoal({ goalId: p });
  assert.deepEqual(result, { ok: false, error: "tree.errors.aboveArchived", values: { name: "867 bajo cercana g1" } });
  assert.ok(g1);
});

test("a depth trigger's 23514 reached through a race says tooDeep and names the goal it would sit under", async () => {
  const a = await mk("867 prof a", 8);
  const b = await mk("867 prof b", 7);
  const c = await mk("867 prof c", 6);
  await mk("867 prof e", 5, c);
  const holder = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  // The row lock stops moveGoal's UPDATE after its pure checks passed (c under b is three levels
  // deep); b is placed under a meanwhile, so only the trigger sees four.
  const held = holder.begin(async (tx) => {
    await tx`select id from goals.goals where id = ${c} for no key update`;
    locked();
    await gate;
  });
  await taken;
  const pending = plan.moveGoal({ goalId: c, parentId: b });
  let waiting = 0;
  try {
    for (let i = 0; i < 100 && waiting < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      [{ waiting }] = await sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks where locktype = 'transactionid' and not granted`;
    }
    await sql`update goals.goals set parent_id = ${a} where id = ${b}`;
  } finally {
    release();
    await held;
    await holder.end();
  }
  assert.ok(waiting >= 1, "the move waits on the goal's row");
  assert.deepEqual(await pending, { ok: false, error: "tree.errors.tooDeep", values: { name: "867 prof b" } });
  assert.equal((await rowOf(c)).parent_id, null);
});
