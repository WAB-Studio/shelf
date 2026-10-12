// Drives `loadDay` (`lib/queries/day.ts`, RP-84, RP-80, RNP-03) as three people
// through `actAs`: goals come back grouped by general in tree order, a general's
// month line is the sum of the lines under it, and the tree costs no statement.
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
let queries: typeof import("@/lib/queries/day");
let zone: typeof import("@/lib/zone");
let months: typeof import("@/lib/plan/months");
let tree: Person;
let plain: Person;
let ended: Person;
let people: Person[];
let today: string;
let sunday: string;
const ids: Record<string, string> = {};

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

const dayAfter = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Seed = {
  key: string;
  name: string;
  horizon: string;
  parent?: string;
  unit?: string;
  budget?: number;
  reached?: number;
};

// The month of `day` carries the budget and a fact of `reached` on `day`.
async function seed(person: Person, day: string, goal: Seed): Promise<void> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit)
    values (${person.id}, ${goal.name}, ${goal.horizon}::date, ${goal.parent ? ids[goal.parent] : null},
            ${goal.unit ?? null}, ${goal.unit ?? null})
    returning id`;
  ids[goal.key] = row.id;
  if (goal.budget !== undefined) {
    await admin`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${row.id}, ${months.monthOf(day)}::date, ${goal.budget})`;
  }
  if (goal.reached !== undefined) {
    const [commitment] = await admin<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
      values (${person.id}, ${row.id}, ${`c ${goal.name}`}, 'daily', 'quantity', 10, ${goal.unit!})
      returning id`;
    await admin`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${row.id}, ${commitment.id}, ${day}::date, ${goal.reached})`;
  }
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  queries = await import("@/lib/queries/day");
  zone = await import("@/lib/zone");
  months = await import("@/lib/plan/months");
  today = zone.todayInZone();
  const [monday] = zone.weekOf(today);
  sunday = zone.weekOf(today)[6];
  const runId = await openCheckRun(admin);
  people = await createPeople(admin, runId, door, 3);
  [tree, plain, ended] = people;
  const far = dayAfter(today, 60);

  // G holds g1, p, g2 (km) and g3, which holds s1; S stands alone; H holds h1 and counts its own 5.
  await seed(tree, today, { key: "G", name: "G", horizon: far });
  await seed(tree, today, { key: "g1", name: "g1", horizon: far, parent: "G", unit: "min", budget: 120, reached: 60 });
  await seed(tree, today, { key: "p", name: "p", horizon: far, parent: "G", unit: "min", budget: 30, reached: 10 });
  await seed(tree, today, { key: "g2", name: "g2", horizon: far, parent: "G", unit: "km", budget: 50, reached: 5 });
  await seed(tree, today, { key: "g3", name: "g3", horizon: far, parent: "G" });
  await seed(tree, today, { key: "s1", name: "s1", horizon: far, parent: "g3", unit: "min", budget: 7, reached: 3 });
  await seed(tree, today, { key: "S", name: "S", horizon: far });
  await seed(tree, today, { key: "H", name: "H", horizon: far, unit: "min", reached: 5 });
  await seed(tree, today, { key: "h1", name: "h1", horizon: far, parent: "H", unit: "min", budget: 20, reached: 10 });

  // Names run against the order they were written in.
  await seed(plain, today, { key: "z", name: "zeta", horizon: far });
  await seed(plain, today, { key: "a", name: "alfa", horizon: far });
  await seed(plain, today, { key: "m", name: "mike", horizon: far });

  // e1 ended on Tuesday of the week; Sunday is a day it is still in the statement and out of the list.
  assert.ok(monday < dayAfter(monday, 1));
  await seed(ended, sunday, { key: "E", name: "E", horizon: far });
  await seed(ended, sunday, { key: "e1", name: "e1", horizon: dayAfter(monday, 1), parent: "E", unit: "min", budget: 10, reached: 4 });
  await seed(ended, sunday, { key: "e2", name: "e2", horizon: far, parent: "E", unit: "min", budget: 20, reached: 6 });
});

after(async () => {
  try {
    const owners = people.map((person) => person.id);
    await admin`delete from goals.facts where user_id in ${admin(owners)}`;
    await admin`delete from goals.commitments where user_id in ${admin(owners)}`;
    await admin`delete from goals.goals where user_id in ${admin(owners)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const named = (goalIds: string[]) => goalIds.map((id) => Object.entries(ids).find(([, v]) => v === id)![0]);

test("one group per general, its goals in tree order", async () => {
  const day = await as(tree, () => queries.loadDay(today));
  assert.deepEqual(
    day.groups.map((group) => ({ root: named([group.rootId])[0], goals: named(group.goalIds) })),
    [
      { root: "G", goals: ["G", "g1", "p", "g2", "g3", "s1"] },
      { root: "S", goals: ["S"] },
      { root: "H", goals: ["H", "h1"] },
    ],
  );
  const summary = (key: string) => day.goals.find((goal) => goal.id === ids[key])!;
  assert.deepEqual(
    ["G", "g1", "s1", "S"].map((key) => [summary(key).level, named([summary(key).rootId])[0]]),
    [["general", "G"], ["large", "G"], ["small", "G"], [null, "S"]],
  );
  assert.equal(summary("s1").parentId, ids.g3);
  assert.equal(summary("G").parentId, null);
});

test("without a tree, one group per goal in today's order", async () => {
  const day = await as(plain, () => queries.loadDay(today));
  assert.deepEqual(day.groups.map((group) => named(group.goalIds)), [["z"], ["a"], ["m"]]);
  assert.deepEqual(day.goals.map((goal) => goal.id), [ids.z, ids.a, ids.m]);
});

test("a general's month line is the sum under it, with no budget of its own", async () => {
  const day = await as(tree, () => queries.loadDay(today));
  // g1 120/60 + p 30/10 + s1 7/3; g2 is in km and stays out.
  assert.deepEqual(
    { planned: day.monthLine[ids.G]?.planned, reached: day.monthLine[ids.G]?.reached, own: day.monthLine[ids.G]?.ownBudget },
    { planned: 157, reached: 73, own: false },
  );
  assert.deepEqual(
    { planned: day.monthLine[ids.g3]?.planned, reached: day.monthLine[ids.g3]?.reached, own: day.monthLine[ids.g3]?.ownBudget },
    { planned: 7, reached: 3, own: false },
  );
  assert.deepEqual(
    { planned: day.monthLine[ids.g1]?.planned, reached: day.monthLine[ids.g1]?.reached, own: day.monthLine[ids.g1]?.ownBudget },
    { planned: 120, reached: 60, own: true },
  );
});

test("a general's own reached adds to its sum", async () => {
  const day = await as(tree, () => queries.loadDay(today));
  assert.deepEqual(
    { planned: day.monthLine[ids.H]?.planned, reached: day.monthLine[ids.H]?.reached },
    { planned: 20, reached: 15 },
  );
});

test("a goal in another unit adds nothing to the sum", async () => {
  const day = await as(tree, () => queries.loadDay(today));
  assert.notEqual(day.monthLine[ids.G]?.planned, 207);
  assert.equal(day.monthLine[ids.g2]?.planned, 50);
});

test("a goal that ended this week still counts in the sum above it", async () => {
  const day = await as(ended, () => queries.loadDay(sunday));
  assert.deepEqual(day.goals.map((goal) => goal.id).sort(), [ids.E, ids.e2].sort());
  assert.deepEqual(day.groups.map((group) => named(group.goalIds)), [["E", "e2"]]);
  assert.deepEqual(
    { planned: day.monthLine[ids.E]?.planned, reached: day.monthLine[ids.E]?.reached },
    { planned: 30, reached: 10 },
  );
  assert.equal(ids.e1 in day.monthLine, false);
});

test("a goal with goals under it carries no plan notice", async () => {
  const day = await as(tree, () => queries.loadDay(today));
  assert.equal(ids.G in day.planNotice, false);
  assert.equal(ids.g3 in day.planNotice, false);
  assert.equal(ids.H in day.planNotice, false);
  assert.equal(ids.g1 in day.planNotice, true);
});

test("the tree costs no statement: a day with one pays what a day without pays", async () => {
  const count = async (person: Person) => {
    wire.length = 0;
    await as(person, () => queries.loadDay(today));
    return wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  };
  const withTree = await count(tree);
  const without = await count(plain);
  assert.equal(withTree.length, without.length);
  // Settle, the session read and the one statement: the reading connection is another wire.
  assert.equal(withTree.length, 3);
});
