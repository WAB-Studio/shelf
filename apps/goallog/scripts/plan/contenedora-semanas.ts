// What `loadGoal` hands the weeks of a goal holding goals (RP-123), and that
// `loadReport` reads the same figure week by week (RP-17, RP-80). Rows are
// planted by the admin door with explicit dates and quantities, so every
// expected total is written down from the plant and never read back through
// the code under test. A lone goal's weeks stay as they were (`check-goal.ts`).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
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

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let session: typeof import("@/lib/session");
let goalQueries: typeof import("@/lib/queries/goal");
let reportQueries: typeof import("@/lib/queries/report");
let today: string;
let month: string;
let owner: Person;

const as = <T>(read: () => Promise<T>): Promise<T> => session.actAs(asResolved(owner), read);

async function plant(
  name: string,
  position: number,
  unit: string,
  extra: { parent?: string; createdDay?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into goals.goals (id, user_id, name, horizon, measure_name, measure_unit, created_at, position, parent_id)
    values (${id}, ${owner.id}, ${name}, ${addDays(today, 200)}, 'Medida', ${unit},
            ${`${extra.createdDay ?? addDays(today, -10)}T15:00:00Z`}, ${position}, ${extra.parent ?? null})`;
  return id;
}

// A quantity declared today against the goal's own unit.
async function reach(goalId: string, quantity: number): Promise<void> {
  const [{ id }] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    select ${owner.id}, g.id, 'plant', 'daily', 'quantity', 10, g.measure_unit from goals.goals g where g.id = ${goalId}
    returning id`;
  await admin`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${owner.id}, ${id}, ${goalId}, ${today}, ${quantity})`;
}

const ids: Record<string, string> = {};

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  reportQueries = await import("@/lib/queries/report");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  month = `${today.slice(0, 7)}-01`;
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);

  // K1: a general over a large over a small, 4 h declared in the small.
  ids.G = await plant("K1 Carrera en IA", 1, "min");
  ids.A = await plant("K1 IA aplicada", 1, "min", { parent: ids.G });
  ids.S = await plant("K1 Evals y harness", 1, "min", { parent: ids.A });
  await reach(ids.S, 240);

  // K1b: the same, with 1 h declared in the large as well.
  ids.G2 = await plant("K1b general", 2, "min");
  ids.A2 = await plant("K1b grande", 1, "min", { parent: ids.G2 });
  ids.S2 = await plant("K1b pequeña", 1, "min", { parent: ids.A2 });
  await reach(ids.A2, 60);
  await reach(ids.S2, 240);

  // K1c: a large in pages under the general adds nothing to its minutes.
  ids.G3 = await plant("K1c general", 3, "min");
  ids.A3 = await plant("K1c grande", 1, "min", { parent: ids.G3 });
  ids.S3 = await plant("K1c pequeña", 1, "min", { parent: ids.A3 });
  ids.P3 = await plant("K1c páginas", 2, "páginas", { parent: ids.G3 });
  await reach(ids.S3, 240);
  await reach(ids.P3, 30);

  // K1d: a task of the general's own, 1 h, done today; hours come from blocks alone (RP-128).
  ids.G4 = await plant("K1d general", 4, "min");
  ids.A4 = await plant("K1d grande", 1, "min", { parent: ids.G4 });
  const [{ id: task }] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month, in_plan)
    values (${owner.id}, ${ids.G4}, 'K1d tarea', 60, ${month}, true) returning id`;
  await admin`
    insert into goals.facts (user_id, goal_id, one_off_id, day) values (${owner.id}, ${ids.G4}, ${task}, ${today})`;

  // K1e: the small opened three weeks before the general.
  ids.G5 = await plant("K1e general", 5, "min");
  ids.A5 = await plant("K1e grande", 1, "min", { parent: ids.G5 });
  ids.S5 = await plant("K1e pequeña", 1, "min", { parent: ids.A5, createdDay: addDays(today, -31) });

  // K1f: a goal that stored a month amount before it received a goal.
  ids.G6 = await plant("K1f general", 6, "min");
  await admin`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${owner.id}, ${ids.G6}, ${month}, 999)`;
  ids.A6 = await plant("K1f grande", 1, "min", { parent: ids.G6 });
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const weeksOf = async (id: string) => {
  const loaded = await as(() => goalQueries.loadGoal(id, today));
  assert.ok(loaded, `goal ${id} loads`);
  return loaded.weeks;
};
const last = <T>(list: T[]): T => list[list.length - 1];

test("a general and its large read this week as the sum of the small goal inside (K1)", async () => {
  for (const id of [ids.G, ids.A]) {
    const weeks = await weeksOf(id);
    assert.equal(last(weeks).current, true);
    assert.equal(last(weeks).total, 240);
  }
});

test("three levels: what the large holds adds to what the small holds", async () => {
  assert.equal(last(await weeksOf(ids.G2)).total, 300);
  assert.equal(last(await weeksOf(ids.A2)).total, 300);
});

test("a goal in another unit adds nothing to the week", async () => {
  assert.equal(last(await weeksOf(ids.G3)).total, 240);
});

test("a done task of the general's own adds nothing to the week (RP-128)", async () => {
  assert.equal(last(await weeksOf(ids.G4)).total, 0);
});

test("the weeks open with the earliest goal inside", async () => {
  const weeks = await weeksOf(ids.G5);
  assert.equal(weeks[0].startsOn, addDays(today, -31));
});

test("loadGoal and loadReport read the same total, week by week", async () => {
  const report = await as(() => reportQueries.loadReport(today));
  for (const id of [ids.G, ids.A, ids.G2, ids.A2, ids.G3, ids.G4, ids.G5]) {
    const fromReport = report.goals.find((entry) => entry.id === id);
    assert.ok(fromReport, `report holds ${id}`);
    assert.deepEqual(
      (await weeksOf(id)).map((week) => [week.startsOn, week.total]),
      fromReport.weeks.map((week) => [week.startsOn, week.total]),
      id,
    );
  }
});

test("the report's general carries no month amount of its own (RP-80)", async () => {
  const report = await as(() => reportQueries.loadReport(today));
  assert.deepEqual(report.goals.find((entry) => entry.id === ids.G6)?.ownMonths, []);
});
