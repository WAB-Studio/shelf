// Drives `loadWeek` (`lib/queries/week.ts`, RP-30, RP-44) as two people through
// `actAs`: a sub-task's fact names its parent, a top-level or goalless one reads
// null, another person's parent never reaches the reader, and the parent rides
// the statement the week already pays. Statements are counted off the wire.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

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

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let queries: typeof import("@/lib/queries/week");
let plan: typeof import("@/app/actions/plan");
let owner: Person;
let other: Person;
let today: string;
let goalId: string;
const ids: Record<string, string> = {};

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

async function done(userId: string, goal: string | null, name: string, parent: string | null): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, parent_id, in_plan)
    values (${userId}, ${goal}, ${name}, ${parent}, ${parent !== null})
    returning id`;
  await admin`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${userId}, ${goal}, ${row.id}, ${today})`;
  return row.id;
}

const factOf = (week: Awaited<ReturnType<typeof queries.loadWeek>>, id: string) =>
  week.oneOffFacts.find((fact) => fact.oneOffId === id);

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  queries = await import("@/lib/queries/week");
  plan = await import("@/app/actions/plan");
  today = (await import("@/lib/zone")).todayInZone();
  const runId = await openCheckRun(admin);
  [owner, other] = await createPeople(admin, runId, door, 2);
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  const goal = await as(owner, () => plan.createGoal({ name: "RP-30 padre", horizon: horizon.toISOString().slice(0, 10) }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalId = goal.goalId;
  ids.parent = await done(owner.id, goalId, "P", null);
  ids.child = await done(owner.id, goalId, "C", ids.parent);
  ids.top = await done(owner.id, goalId, "T", null);
  ids.loose = await done(owner.id, null, "L", null);
});

after(async () => {
  try {
    await admin`delete from goals.goals where id = ${goalId}`;
    await admin`delete from goals.one_offs where id in ${admin(Object.values(ids))}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("a sub-task's fact names its parent", async () => {
  const week = await as(owner, () => queries.loadWeek(today));
  assert.deepEqual(
    { name: factOf(week, ids.child)?.name, parentName: factOf(week, ids.child)?.parentName },
    { name: "C", parentName: "P" },
  );
});

test("a top-level task reads null", async () => {
  const week = await as(owner, () => queries.loadWeek(today));
  assert.equal(factOf(week, ids.top)?.name, "T");
  assert.equal(factOf(week, ids.top)?.parentName, null);
  assert.equal(factOf(week, ids.parent)?.parentName, null);
});

test("a goalless suelta reads null", async () => {
  const week = await as(owner, () => queries.loadWeek(today));
  assert.equal(factOf(week, ids.loose)?.goalId, null);
  assert.equal(factOf(week, ids.loose)?.parentName, null);
});

test("another person's parent never leaks", async () => {
  const week = await as(other, () => queries.loadWeek(today));
  assert.deepEqual(week.oneOffFacts, []);
  assert.equal(JSON.stringify(week).includes('"P"'), false);
});

test("the parent costs no statement: a week with parents pays what an empty one pays", async () => {
  const count = async (person: Person) => {
    wire.length = 0;
    await as(person, () => queries.loadWeek(today));
    assert.equal(wire.filter((query) => /^\s*begin\s*$/i.test(query)).length, 2);
    return wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  };
  // Measured before 395: two transactions, three statements between them.
  const full = await count(owner);
  const empty = await count(other);
  assert.equal(full.length, 3);
  assert.equal(empty.length, 3);
  assert.equal(full.filter((query) => query.includes("one_off_parent_name")).length, 1);
});
