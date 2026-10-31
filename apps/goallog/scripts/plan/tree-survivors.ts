// Proves the figures and the places of a tree of goals that the other tree
// scripts leave unasserted (RP-79, RP-80, RP-81, RP-83, RP-84): a goal whose goals
// are all archived is a goal again, each goal's evidence is its own life's,
// the first month a large goal plans, the day a goal ends, a holder's stored
// rhythm left unread on «Mes» and on paper, and the sums in the report. Rows
// are planted by the admin door; every expected figure is written from the plant.
// a stub that answers the bounds it is handed, as `horizon-evidence.ts` does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import { sql as dsql, type SQL } from "drizzle-orm";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

type ReaderTx = { execute: (query: SQL) => Promise<Array<{ f: string; t: string }>> };
type Planted = { personId: string; day: string; quantity: number };
const planted: Planted[] = [];

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./timelog-apps") return { TIMELOG_SOURCES: [], timelogReader: () => async () => [] };
    if (request === "./reading-lookups") {
      return {
        readReadingLookups: async (args: { personId: string; from: string | SQL; to: string | SQL; tx: ReaderTx }) => {
          const [bounds] = await args.tx.execute(dsql`select (${args.from})::date as f, (${args.to})::date as t`);
          return planted
            .filter((row) => row.personId === args.personId && row.day >= String(bounds.f) && row.day <= String(bounds.t))
            .map((row) => ({
              day: row.day,
              quantity: row.quantity,
              unit: "searches",
              labelKey: "sources.readingLookups",
            }));
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let session: typeof import("@/lib/session");
let goalQueries: typeof import("@/lib/queries/goal");
let today: string;
let month: string;
let farHorizon: string;
let midHorizon: string;

const as = <T>(person: Person, read: () => Promise<T>): Promise<T> => session.actAs(asResolved(person), read);

type GoalSeed = {
  user: Person;
  name: string;
  parent?: string | null;
  position: number;
  unit?: string | null;
  horizon?: string;
  createdDay?: string;
  rhythm?: number | null;
  note?: string | null;
  archived?: boolean;
  id?: string;
};

async function plantGoal(seed: GoalSeed): Promise<string> {
  const id = seed.id ?? randomUUID();
  const created = `${seed.createdDay ?? addDays(today, -10)}T15:00:00Z`;
  await admin`
    insert into goals.goals (id, user_id, name, horizon, measure_name, measure_unit, created_at, archived_at,
                             position, rhythm, parent_id, note)
    values (${id}, ${seed.user.id}, ${seed.name}, ${seed.horizon ?? midHorizon},
            ${seed.unit ? "Medida" : null}, ${seed.unit ?? null}, ${created},
            ${seed.archived ? created : null}, ${seed.position}, ${seed.rhythm ?? null},
            ${seed.parent ?? null}, ${seed.note ?? null})`;
  return id;
}

let db: postgres.Sql | postgres.ReservedSql = admin;
let reserved: postgres.ReservedSql | null = null;
let guardPool: postgres.Sql | null = null;
const pool: Person[] = [];
const nextPerson = (): Person => {
  const person = pool.shift();
  if (!person) throw new Error("no person left in the pool");
  return person;
};

const monthStart = (delta: number): string => {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
};

let reportQueries: typeof import("@/lib/queries/report");
let monthQueries: typeof import("@/lib/queries/month");

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  reportQueries = await import("@/lib/queries/report");
  monthQueries = await import("@/lib/queries/month");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  month = `${today.slice(0, 7)}-01`;
  farHorizon = addDays(today, 200);
  midHorizon = addDays(today, 120);
  const runId = await openCheckRun(admin);
  pool.push(...(await createPeople(admin, runId, door, 14)));
  // The guard probes run inside one transaction that is rolled back; a mutation proof of a guard replaces
  // its function in that same transaction, so the shared stack is never altered.
  // Its own connection: the admin one is a single connection the other tests wait on.
  guardPool = adminSql();
  reserved = await guardPool.reserve();
  await reserved`begin`;
  if (process.env.GUARD_MUTANT_SQL) await reserved.unsafe(readFileSync(process.env.GUARD_MUTANT_SQL, "utf8"));
  db = reserved;
});

after(async () => {
  try {
    if (reserved) {
      await reserved`rollback`;
      reserved.release();
    }
    await guardPool?.end();
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const view = async (person: Person, id: string) => {
  const loaded = await as(person, () => goalQueries.loadGoal(id, today));
  assert.ok(loaded, `goal ${id} loads`);
  return loaded;
};

const budget = (person: Person, goalId: string, monthDay: string, amount: number) =>
  admin`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goalId}, ${monthDay}, ${amount})`;

async function evidenceCommitment(person: Person, goalId: string): Promise<void> {
  const [{ id: sourceId }] = await admin<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
  await admin`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold)
    values (${person.id}, ${goalId}, 'evidence', 'daily', 'evidence', ${sourceId}, 1)`;
}

test("a general whose goals are all archived is a goal again: its own month, on its screen and on /metas (RP-83)", async () => {
  const u = nextPerson();
  const g = await plantGoal({ user: u, name: "S1 general", position: 1, unit: "min", horizon: farHorizon });
  const archivedKid = await plantGoal({ user: u, name: "S1 archived", parent: g, position: 1, unit: "min", archived: true });
  await budget(u, g, month, 80);
  await budget(u, archivedKid, month, 5000);

  const loaded = await view(u, g);
  assert.equal(loaded.holdsGoals, false);
  assert.deepEqual(loaded.budgets.map((b) => b.amount), [80]);
  assert.equal(loaded.month?.planned, 80);

  const metas = await as(u, () => goalQueries.listGoalsForMetas(today));
  const row = metas.open.find((r) => r.id === g);
  assert.deepEqual(row?.month, { kind: "amount", month, planned: 80, reached: 0 });
  assert.deepEqual(row?.outOfUnit, []);
});

test("a goal's reading is counted inside its own life only: not before it opened, not on its end day or after (RP-80)", async () => {
  const u = nextPerson();
  const g = await plantGoal({ user: u, name: "S2 general", position: 1, unit: "searches", horizon: farHorizon, createdDay: addDays(today, -30) });
  await plantGoal({ user: u, name: "S2 early", parent: g, position: 1, unit: "searches", createdDay: addDays(today, -30) });
  const late = await plantGoal({
    user: u,
    name: "S2 late",
    parent: g,
    position: 2,
    unit: "searches",
    createdDay: addDays(today, -10),
    horizon: addDays(today, -3),
  });
  await evidenceCommitment(u, late);
  // Its life is today-10 to today-4: the horizon is the first day after it.
  for (const [offset, quantity] of [[-20, 100], [-11, 10], [-10, 1], [-5, 1000], [-4, 10000], [-3, 100000]] as const) {
    planted.push({ personId: u.id, day: addDays(today, offset), quantity });
  }
  const loaded = await view(u, g);
  assert.equal(loaded.measureTotal, 11001);
});

test("a large goal's first planned month is the first one from this month on with an amount above zero (RP-81)", async () => {
  const u = nextPerson();
  const h = await plantGoal({ user: u, name: "S3 general", position: 1, unit: "min", horizon: farHorizon, createdDay: addDays(monthStart(-1), 2) });
  const l = await plantGoal({ user: u, name: "S3 large", parent: h, position: 1, unit: "min", createdDay: addDays(monthStart(-1), 2) });
  await budget(u, l, monthStart(-1), 50);
  await budget(u, l, monthStart(0), 0);
  await budget(u, l, monthStart(1), 300);
  await budget(u, l, monthStart(2), 500);
  const loaded = await view(u, h);
  assert.deepEqual(loaded.children.find((c) => c.id === l)?.firstPlanned, { month: monthStart(1), planned: 300 });
  // The months a holder draws: only the current one is current, only earlier ones are past.
  const prev = loaded.months.find((m) => m.month === monthStart(-1));
  const cur = loaded.months.find((m) => m.month === monthStart(0));
  assert.deepEqual([prev?.past, prev?.current, cur?.past, cur?.current], [true, false, false, true]);
});

test("a goal with no unit under a holder with none is not in its unit; one in the holder's unit is (RP-80)", async () => {
  const u = nextPerson();
  const h = await plantGoal({ user: u, name: "S4 general", position: 1, horizon: farHorizon });
  const bare = await plantGoal({ user: u, name: "S4 bare", parent: h, position: 1 });
  const loaded = await view(u, h);
  assert.equal(loaded.children.find((c) => c.id === bare)?.inUnit, false);

  const v = nextPerson();
  const h2 = await plantGoal({ user: v, name: "S4 unit general", position: 1, unit: "min", horizon: farHorizon });
  const same = await plantGoal({ user: v, name: "S4 same", parent: h2, position: 1, unit: "min" });
  const km = await plantGoal({ user: v, name: "S4 km", parent: h2, position: 2, unit: "km" });
  const other = await view(v, h2);
  assert.deepEqual(other.children.map((c) => [c.id, c.inUnit]), [[same, true], [km, false]]);
});

test("a goal whose horizon is today has ended: it says so, leaves «Abiertas» for «Terminadas» and the open list (RP-24, RP-79)", async () => {
  const u = nextPerson();
  const g = await plantGoal({ user: u, name: "S5 general", position: 1, unit: "min", horizon: farHorizon });
  const endsToday = await plantGoal({ user: u, name: "S5 ends today", parent: g, position: 1, unit: "min", horizon: today });
  const endsTomorrow = await plantGoal({ user: u, name: "S5 ends tomorrow", parent: g, position: 2, unit: "min", horizon: addDays(today, 1) });
  const loaded = await view(u, g);
  assert.equal(loaded.children.find((c) => c.id === endsToday)?.endedOn, addDays(today, -1));
  assert.equal(loaded.children.find((c) => c.id === endsTomorrow)?.endedOn, null);

  const metas = await as(u, () => goalQueries.listGoalsForMetas(today));
  assert.deepEqual(metas.open.map((r) => r.id).sort(), [g, endsTomorrow].sort());
  assert.deepEqual(metas.ended.map((r) => r.id), [endsToday]);

  const rail = await as(u, () => goalQueries.listGoals());
  assert.deepEqual(rail.map((r) => r.id).sort(), [g, endsTomorrow].sort());
});

// A holder that kept a stored rhythm, and a task of its plan that no month
// holds yet; a goal alone with the same rows is the control.
async function plantRhythmHolder(u: Person, tag: string) {
  const created = addDays(today, -40);
  const holder = await plantGoal({ user: u, name: `${tag} holder`, position: 1, unit: "min", horizon: farHorizon, createdDay: created, rhythm: 600 });
  const control = await plantGoal({ user: u, name: `${tag} control`, position: 3, unit: "min", horizon: farHorizon, createdDay: created, rhythm: 600 });
  const kid = await plantGoal({ user: u, name: `${tag} kid`, parent: holder, position: 2, unit: "min", createdDay: created });
  await budget(u, kid, month, 50);
  for (const goalId of [holder, control]) {
    await admin`
      insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, created_at)
      values (${u.id}, ${goalId}, ${`${tag} task`}, 30, true, ${`${created}T15:00:00Z`})`;
  }
  return { holder, control };
}

test("a holder that kept a stored rhythm places no task of its plan on «Mes» or on paper (RP-80, RP-84)", async () => {
  const u = nextPerson();
  const { holder, control } = await plantRhythmHolder(u, "S6");

  const across = await as(u, () => monthQueries.loadMonthAcross(today));
  const items = (id: string) => across.goals.find((g) => g.id === id)?.items.map((i) => i.task.name);
  assert.deepEqual(items(control), ["S6 task"], "a goal alone places it");
  assert.deepEqual(items(holder), []);

  const report = await as(u, () => reportQueries.loadReport(today));
  const tasks = (id: string) => report.goals.find((g) => g.id === id)?.tasks.map((t) => t.name);
  assert.deepEqual(tasks(control), ["S6 task"], "a goal alone places it");
  assert.deepEqual(tasks(holder), []);
});

const commitmentOf = new Map<string, string>();
// A quantity done on a day, in the goal's own unit.
async function fact(person: Person, goalId: string, day: string, quantity: number): Promise<void> {
  let commitmentId = commitmentOf.get(goalId);
  if (!commitmentId) {
    [{ id: commitmentId }] = await admin<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
      select ${person.id}, g.id, 'plant', 'daily', 'quantity', 10, g.measure_unit from goals.goals g where g.id = ${goalId}
      returning id`;
    commitmentOf.set(goalId, commitmentId);
  }
  await admin`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${person.id}, ${commitmentId}, ${goalId}, ${day}, ${quantity})`;
}

// The first of a month that is not a Monday, so the week it sits in crosses into the month before.
function crossingFirst(): string {
  for (let delta = -1; ; delta -= 1) {
    const first = monthStart(delta);
    if (new Date(`${first}T00:00:00Z`).getUTCDay() !== 1) return first;
  }
}

test("a general's paper week and plan add the goals in its unit only, and the cut week splits the same sums (RP-80, RP-84)", async () => {
  const u = nextPerson();
  const T = crossingFirst();
  const opened = addDays(T, -30);
  const g = await plantGoal({ user: u, name: "S8 general", position: 1, unit: "min", horizon: farHorizon, createdDay: opened });
  const a = await plantGoal({ user: u, name: "S8 A", parent: g, position: 2, unit: "min", createdDay: opened, rhythm: 600 });
  const c = await plantGoal({ user: u, name: "S8 C km", parent: g, position: 3, unit: "km", createdDay: opened, rhythm: 90 });
  const before = addDays(T, -1);
  await fact(u, a, before, 30);
  await fact(u, a, T, 20);
  await fact(u, c, before, 7);
  await fact(u, c, T, 5);

  const report = await as(u, () => reportQueries.loadReport(T));
  const G = report.goals.find((x) => x.id === g)!;
  const A = report.goals.find((x) => x.id === a)!;
  const C = report.goals.find((x) => x.id === c)!;
  assert.ok((A.weekPlanned ?? 0) > 0 && (C.weekPlanned ?? 0) > 0, "each goal plans something this week");
  assert.equal(G.weekPlanned, A.weekPlanned, "only the goal in its unit adds to the week's plan");
  const current = G.weeks.find((w) => w.current)!;
  assert.equal(current.total, 50);
  // The week the 1st sits in, cut at the 1st: 30 before it, 20 on it.
  assert.deepEqual(
    G.weekSplits.filter((s) => s.index === current.index).map((s) => [s.month, s.total]),
    [[`${before.slice(0, 7)}-01`, 30], [T, 20]],
  );
});

async function task(person: Person, goalId: string, name: string, plannedMonth: string | null, extra: { estimate?: number; doneOn?: string } = {}) {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, in_plan, created_at)
    values (${person.id}, ${goalId}, ${name}, ${plannedMonth}, ${extra.estimate ?? 30}, true, ${`${addDays(monthStart(-1), 2)}T15:00:00Z`})
    returning id`;
  if (extra.doneOn) {
    await admin`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${row.id}, ${extra.doneOn})`;
  }
}

test("a holder's months on paper: its own undone task carries out of a past month, the current month is not past, and only a time holder counts tasks (RP-80, RP-84)", async () => {
  const u = nextPerson();
  const created = addDays(monthStart(-1), 2);
  const km = await plantGoal({ user: u, name: "S9 km holder", position: 1, unit: "km", horizon: farHorizon, createdDay: created });
  await plantGoal({ user: u, name: "S9 km kid", parent: km, position: 2, unit: "km", createdDay: created });
  const min = await plantGoal({ user: u, name: "S9 min holder", position: 3, unit: "min", horizon: farHorizon, createdDay: created });
  const minKid = await plantGoal({ user: u, name: "S9 min kid", parent: min, position: 4, unit: "min", createdDay: created });
  await task(u, km, "S9 km old", monthStart(-1), { estimate: 40 });
  await task(u, min, "S9 min old", monthStart(-1), { estimate: 40 });
  await task(u, min, "S9 min now", monthStart(0));
  await task(u, minKid, "S9 kid now", monthStart(0));
  await task(u, minKid, "S9 kid done", monthStart(0), { doneOn: today });

  const report = await as(u, () => reportQueries.loadReport(today));
  const monthOfGoal = (id: string, m: string) => report.goals.find((x) => x.id === id)?.months.find((x) => x.month === m);
  for (const id of [km, min]) {
    assert.equal(monthOfGoal(id, monthStart(-1))?.carried, 100, "its own task was left undone in the past month");
    assert.deepEqual(
      [monthOfGoal(id, monthStart(0))?.current, monthOfGoal(id, monthStart(0))?.past, monthOfGoal(id, monthStart(-1))?.past],
      [true, false, true],
    );
  }
  assert.equal(monthOfGoal(km, monthStart(0))?.tasks, undefined, "an amount in km is read by the amount, not by tasks");
  assert.deepEqual(monthOfGoal(min, monthStart(0))?.tasks, { done: 1, total: 4 });
});

test("a holder with no unit plans no week amount and counts no week total (RP-80, RP-84)", async () => {
  const u = nextPerson();
  const created = addDays(today, -20);
  const g = await plantGoal({ user: u, name: "S10 general", position: 1, horizon: farHorizon, createdDay: created });
  const k = await plantGoal({ user: u, name: "S10 kid", parent: g, position: 2, createdDay: created });
  await budget(u, k, month, 600);
  await task(u, k, "S10 done", monthStart(0), { doneOn: today });
  const report = await as(u, () => reportQueries.loadReport(today));
  const G = report.goals.find((x) => x.id === g)!;
  assert.equal(G.unit, null);
  assert.equal(G.weekPlanned, null);
  assert.deepEqual(G.weeks.map((w) => w.total).filter((t) => t !== 0), []);
});

// The tree's guard in the database (RP-79, RP-80), probed as the owner of the rows: the pure
// refusals in the actions run first, so only a write that reaches the table meets these.
async function guardGoal(person: Person, name: string, horizonOffset: number, parent: string | null = null, rhythm: number | null = null) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, rhythm)
    values (${person.id}, ${name}, ${addDays(today, horizonOffset)}, ${rhythm === null ? null : "Medida"}, ${rhythm === null ? null : "min"}, ${parent}, ${rhythm})
    returning id`;
  return row.id;
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; constraint: string | undefined; detail: string | undefined } | null> {
  // A savepoint, so a refusal inside the mutation proof's transaction leaves it usable.
  await db`savepoint probe`;
  try {
    await run();
    await db`release savepoint probe`;
    return null;
  } catch (error) {
    await db`rollback to savepoint probe`;
    const e = error as { code?: string; constraint_name?: string; detail?: string };
    return { code: e.code ?? "", constraint: e.constraint_name, detail: e.detail };
  }
}

test("database guard: a goal that kept a stored rhythm can still move its end and its place (RP-80)", async () => {
  const u = nextPerson();
  const top = await guardGoal(u, "G1 top", 300);
  const holder = await guardGoal(u, "G1 holder", 200, null, 600);
  await guardGoal(u, "G1 kid", 100, holder);
  assert.equal(await refusalOf(() => db`update goals.goals set horizon = ${addDays(today, 150)} where id = ${holder}`), null);
  assert.equal(await refusalOf(() => db`update goals.goals set parent_id = ${top} where id = ${holder}`), null);
});

test("database guard: a goal may end the very day its last goal ends (RP-79)", async () => {
  const u = nextPerson();
  const holder = await guardGoal(u, "G2 holder", 200);
  await guardGoal(u, "G2 kid", 100, holder);
  assert.equal(await refusalOf(() => db`update goals.goals set horizon = ${addDays(today, 100)} where id = ${holder}`), null);
  assert.deepEqual(
    await refusalOf(() => db`update goals.goals set horizon = ${addDays(today, 99)} where id = ${holder}`),
    { code: "23514", constraint: "goals_tree_end", detail: (await db<{ id: string }[]>`select id from goals.goals where name = 'G2 kid' and user_id = ${u.id}`)[0].id },
  );
});

test("database guard: moving an end before several goals names the one that ends last (RP-79)", async () => {
  const u = nextPerson();
  const holder = await guardGoal(u, "G3 holder", 200);
  await guardGoal(u, "G3 early", 40, holder);
  const last = await guardGoal(u, "G3 last", 80, holder);
  await guardGoal(u, "G3 middle", 60, holder);
  const refusal = await refusalOf(() => db`update goals.goals set horizon = ${addDays(today, 10)} where id = ${holder}`);
  assert.deepEqual(refusal, { code: "23514", constraint: "goals_tree_end", detail: last });
});
