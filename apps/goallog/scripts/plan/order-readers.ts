// Drives the readers' plan order (RP-47): rows planted in ONE
// statement share `created_at`, so only `position` can put them in order. The
// names run against the positions and the ids against both, so a name or uuid sort fails too. Runs on the session
// `harness:mint-session` left standing, with `server-only`, `next/headers` and
// `next/cache` stubbed before the first `@/` import.
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

const lane = laneNumber();

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = resolve(process.cwd(), `private/session-${lane}.json`);
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
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });


const LOADS = 20;

// Ids drawn highest first: plan order is the reverse of uuid order, so a read
// that falls back to `id` cannot pass by luck.
function descendingIds(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID()).sort().reverse();
}

let goalId: string;
let today: string;
const taskIds: string[] = [];
const commitmentIds: string[] = [];
let userId: string;
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;
let listGoals: typeof import("@/lib/queries/goal").listGoals;
let listGoalsForMetas: typeof import("@/lib/queries/goal").listGoalsForMetas;
let loadMonthAcross: typeof import("@/lib/queries/month").loadMonthAcross;
let loadWeek: typeof import("@/lib/queries/week").loadWeek;

// Positions 2 then 1, names Alfa then Zeta: position order is Zeta, Alfa.
let firstInPlan: string;
let secondInPlan: string;

before(async () => {
  installStubs(loadCookies());
  ({ loadGoal, listGoals, listGoalsForMetas } = await import("@/lib/queries/goal"));
  ({ loadMonthAcross } = await import("@/lib/queries/month"));
  ({ loadWeek } = await import("@/lib/queries/week"));
  const plan = await import("@/app/actions/plan");
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const created = await plan.createGoal({
    name: "RP-47 fixture: orden",
    horizon: `${monthFrom(today, 2)}-01`,
  });
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalId = created.goalId;
  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from goals.goals where id = ${goalId}`;
  userId = owner.user_id;
  const thisMonth = `${today.slice(0, 7)}-01`;
  const horizon = `${monthFrom(today, 2)}-01`;
  const [goalFirst, goalSecond] = descendingIds(2);
  const pair = await sql<{ id: string; name: string }[]>`
    insert into goals.goals (id, user_id, name, horizon, position)
    values (${goalSecond}, ${userId}, 'RP-47 Alfa', ${horizon}, 900002),
           (${goalFirst}, ${userId}, 'RP-47 Zeta', ${horizon}, 900001)
    returning id, name`;
  firstInPlan = pair.find((row) => row.name === "RP-47 Zeta")!.id;
  secondInPlan = pair.find((row) => row.name === "RP-47 Alfa")!.id;
  const [t1, t2, t3] = descendingIds(3);
  const tasks = await sql<{ id: string; position: number }[]>`
    insert into goals.one_offs (id, user_id, goal_id, name, planned_month, position)
    values (${t3}, ${userId}, ${goalId}, 'RP-47 X', ${thisMonth}, 3),
           (${t1}, ${userId}, ${goalId}, 'RP-47 Z', ${thisMonth}, 1),
           (${t2}, ${userId}, ${goalId}, 'RP-47 Y', ${thisMonth}, 2)
    returning id, position`;
  taskIds.push(...tasks.sort((a, b) => a.position - b.position).map((row) => row.id));
  const [c1, c2] = descendingIds(2);
  const commitments = await sql<{ id: string; position: number }[]>`
    insert into goals.commitments (id, user_id, goal_id, name, cadence_kind, satisfaction, position)
    values (${c2}, ${userId}, ${goalId}, 'RP-47 c-Z', 'daily', 'tap', 2),
           (${c1}, ${userId}, ${goalId}, 'RP-47 c-A', 'daily', 'tap', 1)
    returning id, position`;
  commitmentIds.push(...commitments.sort((a, b) => a.position - b.position).map((row) => row.id));
});

after(async () => {
  if (goalId) await sql`delete from goals.goals where id = ${goalId}`;
  if (firstInPlan) await sql`delete from goals.goals where id in (${firstInPlan}, ${secondInPlan})`;
  await sql.end();
});

function fixtureOrder(ids: string[]): string[] {
  return ids.filter((id) => id === firstInPlan || id === secondInPlan);
}

const PAIR = () => [firstInPlan, secondInPlan];

test("loadGoal: three tasks inserted in one statement at positions 3, 1, 2 read 1, 2, 3", async () => {
  for (let load = 0; load < LOADS; load++) {
    const goal = await loadGoal(goalId, today);
    assert.ok(goal);
    assert.deepEqual(goal.tasks.map((task) => task.id), taskIds);
  }
});

test("loadGoal: commitments inserted in one statement at positions 2, 1 read 1, 2", async () => {
  for (let load = 0; load < LOADS; load++) {
    const goal = await loadGoal(goalId, today);
    assert.ok(goal);
    assert.deepEqual(goal.commitments.map((commitment) => commitment.id), commitmentIds);
  }
});

test("loadMonthAcross: the goal's tasks read in plan order, ten loads", async () => {
  for (let load = 0; load < 10; load++) {
    const month = await loadMonthAcross(today);
    const goal = month.goals.find((entry) => entry.id === goalId);
    assert.ok(goal);
    assert.deepEqual(goal.items.map((item) => item.task.id), taskIds);
  }
});

test("loadMonthAcross: two goals at positions 2, 1 read 1, 2", async () => {
  for (let load = 0; load < LOADS; load++) {
    const month = await loadMonthAcross(today);
    assert.deepEqual(fixtureOrder(month.goals.map((goal) => goal.id)), PAIR());
  }
});

test("listGoals: two goals at positions 2, 1 read 1, 2", async () => {
  for (let load = 0; load < LOADS; load++) {
    assert.deepEqual(fixtureOrder((await listGoals()).map((goal) => goal.id)), PAIR());
  }
});

test("listGoalsForMetas: two goals at positions 2, 1 read 1, 2; the tasks fold to counts", async () => {
  for (let load = 0; load < LOADS; load++) {
    const { open } = await listGoalsForMetas(today);
    assert.deepEqual(fixtureOrder(open.map((goal) => goal.id)), PAIR());
  }
  const { open } = await listGoalsForMetas(today);
  const entry = open.find((goal) => goal.id === goalId);
  assert.deepEqual(entry?.month && entry.month.kind === "tasks" ? [entry.month.done, entry.month.total] : null, [0, 3]);
});

test("loadWeek: two goals at positions 2, 1 read 1, 2", async () => {
  for (let load = 0; load < LOADS; load++) {
    const { goals } = await loadWeek(today);
    assert.deepEqual(fixtureOrder(goals.map((goal) => goal.id)), PAIR());
  }
});

test("loadWeek: commitments of one goal read in plan order", async () => {
  for (let load = 0; load < LOADS; load++) {
    const { commitments } = await loadWeek(today);
    assert.deepEqual(
      commitments.filter((commitment) => commitmentIds.includes(commitment.id)).map((commitment) => commitment.id),
      commitmentIds,
    );
  }
});
