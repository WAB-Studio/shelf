// Drives `scheduleOneOff` (`app/actions/one-offs.ts`, RP-59, RP-61) as a person
// through `actAs`: a loose task with no fact moves whether dated or not, a
// task with a fact or children does not. The admin pool seeds past days and
// reads the row back; `ownerUpdate` drives `one_offs_guard_day` (0017) alone.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import { sql } from "drizzle-orm";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
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
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let oneOffs: typeof import("@/app/actions/one-offs");
let plan: typeof import("@/app/actions/plan");
let owner: Person;
let today: string;
const goalIds: string[] = [];

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(fn: () => Promise<T>) => session.actAs(asResolved(owner), fn);

async function dayOf(oneOffId: string): Promise<string | null> {
  const [row] = await admin<{ day: string | null }[]>`select day::text as day from goals.one_offs where id = ${oneOffId}`;
  return row.day;
}

// A bare UPDATE as the authenticated owner: no action, only the policy and the trigger decide.
async function ownerUpdate(oneOffId: string, set: { day: string } | { plannedMonth: string }): Promise<number> {
  const assignment =
    "day" in set ? sql`day = ${set.day}::date` : sql`planned_month = ${set.plannedMonth}::date`;
  const rows = await as(() =>
    session.withGoalsDb((tx) =>
      tx.execute(sql`update goals.one_offs set ${assignment} where id = ${oneOffId} returning id`),
    ),
  );
  return rows.length;
}

async function seedAt(day: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day) values (${owner.id}, 'RP-61 suelta', ${day}::date) returning id`;
  return row.id;
}

const shift = (days: number): string => {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  oneOffs = await import("@/app/actions/one-offs");
  plan = await import("@/app/actions/plan");
  today = (await import("@/lib/zone")).todayInZone();
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await admin`delete from goals.one_offs where user_id = ${owner.id}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("today: a task dated today moves to tomorrow", async () => {
  const id = await seedAt(today);
  assert.deepEqual(await as(() => oneOffs.scheduleOneOff({ oneOffId: id, day: shift(1) })), { ok: true });
  assert.equal(await dayOf(id), shift(1));
});

test("dragged: a task three days old with no fact moves to today", async () => {
  const id = await seedAt(shift(-3));
  assert.deepEqual(await as(() => oneOffs.scheduleOneOff({ oneOffId: id, day: today })), { ok: true });
  assert.equal(await dayOf(id), today);
});

test("same day: ok and nothing written", async () => {
  const stay = await seedAt(today);
  assert.deepEqual(await as(() => oneOffs.scheduleOneOff({ oneOffId: stay, day: today })), { ok: true });
  assert.equal(await dayOf(stay), today);
});

test("done no: a task with a fact keeps its day", async () => {
  const id = await seedAt(shift(-1));
  await admin`insert into goals.facts (user_id, one_off_id, day) values (${owner.id}, ${id}, ${shift(-1)}::date)`;
  const result = await as(() => oneOffs.scheduleOneOff({ oneOffId: id, day: shift(2) }));
  assert.deepEqual(result, { ok: false, error: "day.errors.oneOffHasFact" });
  assert.equal(await dayOf(id), shift(-1));
  assert.equal(await ownerUpdate(id, { day: shift(2) }), 0);
  assert.equal(await dayOf(id), shift(-1));
});

test("trigger: a task carried from a past day takes a new day by a bare update as its owner", async () => {
  const id = await seedAt(shift(-2));
  assert.equal(await ownerUpdate(id, { day: shift(1) }), 1);
  assert.equal(await dayOf(id), shift(1));
});

test("trigger: a goal task dated today still keeps its month", async () => {
  const goal = await as(() => plan.createGoal({ name: "mes", horizon: `${today.slice(0, 4)}-12-31` }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalIds.push(goal.goalId);
  const [task] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, in_plan, day)
    values (${owner.id}, ${goal.goalId}, 'con día', true, ${today}::date) returning id`;
  assert.equal(await ownerUpdate(task.id, { plannedMonth: `${today.slice(0, 7)}-01` }), 0);
  const [row] = await admin<{ planned_month: string | null }[]>`
    select planned_month::text from goals.one_offs where id = ${task.id}`;
  assert.equal(row.planned_month, null);
});

test("mother no: a task with children takes no day", async () => {
  const goal = await as(() => plan.createGoal({ name: "padre", horizon: `${today.slice(0, 4)}-12-31` }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalIds.push(goal.goalId);
  const [mother] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, in_plan) values (${owner.id}, ${goal.goalId}, 'madre', true) returning id`;
  await admin`insert into goals.one_offs (user_id, goal_id, name, in_plan, parent_id) values (${owner.id}, ${goal.goalId}, 'hija', true, ${mother.id})`;
  const result = await as(() => oneOffs.scheduleOneOff({ oneOffId: mother.id, day: shift(1) }));
  assert.deepEqual(result, { ok: false, error: "month.errors.parentIsDoneByChildren" });
  assert.equal(await dayOf(mother.id), null);
});

test("past no: a new day before today is the schema's refusal", async () => {
  const id = await seedAt(today);
  const result = await as(() => oneOffs.scheduleOneOff({ oneOffId: id, day: shift(-1) }));
  assert.deepEqual(result, { ok: false, error: "day.errors.oneOffDayPast" });
  assert.equal(await dayOf(id), today);
});
