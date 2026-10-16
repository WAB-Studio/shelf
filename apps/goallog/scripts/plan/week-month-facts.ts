// `loadWeek` feeds `deriveWeek` the facts a «N al mes» needs to know its month
// is met (RP-12): from the 1st, not from the week's Monday. Driven on a past
// month so the verdict does not depend on the day the suite runs.
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
  if (state.cookies.length === 0) throw new Error(`${file} carries no cookie`);
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
    return originalLoad(request, parent, isMain);
  };
}

function priorMonth(day: string): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 2;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let goalId: string;
let metId: string;
let openId: string;
let thirdWeekDay: string;
let loadWeek: typeof import("@/lib/queries/week").loadWeek;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  ({ loadWeek } = await import("@/lib/queries/week"));
  const { todayInZone } = await import("@/lib/zone");
  const month = priorMonth(todayInZone());
  thirdWeekDay = `${month}-15`;

  const horizon = `${Number(todayInZone().slice(0, 4)) + 1}-12-31`;
  const created = await plan.createGoal({ name: "week-month-facts.ts probe", horizon });
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalId = created.goalId;
  async function monthly(name: string, count: number): Promise<string> {
    const made = await plan.addCommitment({
      goalId,
      name,
      cadenceKind: "times_per_month",
      cadenceN: count,
      satisfaction: "tap",
    });
    if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
    return made.commitmentId;
  }
  metId = await monthly("week-month-facts: cumplido", 2);
  openId = await monthly("week-month-facts: abierto", 3);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${goalId}`;
  await sql`update goals.goals set created_at = now() - interval '90 days' where id = ${goalId}`;
  await sql`update goals.commitments set created_at = now() - interval '90 days' where goal_id = ${goalId}`;
  for (const id of [metId, openId]) {
    for (const day of [`${month}-01`, `${month}-02`]) {
      await sql`insert into goals.facts (user_id, goal_id, commitment_id, day)
                values (${owner.user_id}, ${goalId}, ${id}, ${day}::date)`;
    }
  }
});

after(async () => {
  if (goalId) await sql`delete from goals.goals where id = ${goalId}`;
  await sql.end();
});

function askedDays(week: Awaited<ReturnType<typeof loadWeek>>, id: string): number[] {
  return week.view.days.map((day) => day.slots.filter((slot) => slot.commitmentId === id).length);
}

test("loadWeek: a «2 al mes» met on the 1st and 2nd asks nothing in the third week", async () => {
  const week = await loadWeek(thirdWeekDay);
  assert.deepEqual(askedDays(week, metId), [0, 0, 0, 0, 0, 0, 0]);
});

test("loadWeek: a «3 al mes» with two taps still asks every day of the third week", async () => {
  const week = await loadWeek(thirdWeekDay);
  assert.deepEqual(askedDays(week, openId), [1, 1, 1, 1, 1, 1, 1]);
});

test("loadWeek: a «1 al mes» met before the week, in the prior month, asks nothing in the six days of that month, and the new month asks again", async () => {
  const plan = await import("@/app/actions/plan");
  const made = await plan.addCommitment({
    goalId,
    name: "week-month-facts: a caballo",
    cadenceKind: "times_per_month",
    cadenceN: 1,
    satisfaction: "tap",
  });
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${goalId}`;
  await sql`update goals.commitments set created_at = '2026-01-01' where id = ${made.commitmentId}`;
  // Week 2026-02-23 to 2026-03-01: six February days and the 1st of March; the fact sits before the Monday.
  await sql`insert into goals.facts (user_id, goal_id, commitment_id, day)
            values (${owner.user_id}, ${goalId}, ${made.commitmentId}, '2026-02-10'::date)`;
  const week = await loadWeek("2026-02-25");
  assert.deepEqual(askedDays(week, made.commitmentId), [0, 0, 0, 0, 0, 0, 1]);
});

test("loadWeek: a «4 al mes» with two taps in the month and two in the month before still asks the third week", async () => {
  const plan = await import("@/app/actions/plan");
  const made = await plan.addCommitment({
    goalId,
    name: "week-month-facts: otro mes",
    cadenceKind: "times_per_month",
    cadenceN: 4,
    satisfaction: "tap",
  });
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${goalId}`;
  await sql`update goals.commitments set created_at = now() - interval '200 days' where id = ${made.commitmentId}`;
  const before = priorMonth(`${thirdWeekDay.slice(0, 7)}-01`);
  for (const day of [`${thirdWeekDay.slice(0, 7)}-01`, `${thirdWeekDay.slice(0, 7)}-02`, `${before}-10`, `${before}-11`]) {
    await sql`insert into goals.facts (user_id, goal_id, commitment_id, day)
              values (${owner.user_id}, ${goalId}, ${made.commitmentId}, ${day}::date)`;
  }
  const week = await loadWeek(thirdWeekDay);
  assert.deepEqual(askedDays(week, made.commitmentId), [1, 1, 1, 1, 1, 1, 1]);
});

test("loadWeek: a fact declared on the Sunday is read into the Sunday", async () => {
  const plan = await import("@/app/actions/plan");
  const made = await plan.addCommitment({
    goalId,
    name: "week-month-facts: domingo",
    cadenceKind: "daily",
    satisfaction: "tap",
  });
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${goalId}`;
  await sql`update goals.commitments set created_at = '2026-01-01' where id = ${made.commitmentId}`;
  // Week 2026-02-09 to 2026-02-15: the fact sits on the last day.
  await sql`insert into goals.facts (user_id, goal_id, commitment_id, day)
            values (${owner.user_id}, ${goalId}, ${made.commitmentId}, '2026-02-15'::date)`;
  const week = await loadWeek("2026-02-11");
  const sunday = week.view.days[6].slots.find((slot) => slot.commitmentId === made.commitmentId);
  const saturday = week.view.days[5].slots.find((slot) => slot.commitmentId === made.commitmentId);
  assert.equal(sunday?.satisfied, true);
  assert.equal(saturday?.satisfied, false);
});

test("loadWeek: a «1 al mes» met before the week and tapped again on the Tuesday lists only that Tuesday, done", async () => {
  const plan = await import("@/app/actions/plan");
  const made = await plan.addCommitment({
    goalId,
    name: "week-month-facts: cumplida sin pedir",
    cadenceKind: "times_per_month",
    cadenceN: 1,
    satisfaction: "tap",
  });
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${goalId}`;
  await sql`update goals.commitments set created_at = '2026-01-01' where id = ${made.commitmentId}`;
  for (const day of ["2026-02-02", "2026-02-10"]) {
    await sql`insert into goals.facts (user_id, goal_id, commitment_id, day)
              values (${owner.user_id}, ${goalId}, ${made.commitmentId}, ${day}::date)`;
  }
  const week = await loadWeek("2026-02-11");
  assert.deepEqual(askedDays(week, made.commitmentId), [0, 1, 0, 0, 0, 0, 0]);
  assert.equal(week.view.days[1].slots.find((slot) => slot.commitmentId === made.commitmentId)?.satisfied, true);
});
