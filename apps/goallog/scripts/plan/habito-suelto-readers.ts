// A habit with no goal (RP-100) reaches Hoy, Semana and Mes beside the goals, with no goal to
// hang it from, and the week reaches back to the Monday of the first one. The expected values
// are written down from the plant.
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
    return originalLoad(request, parent, isMain);
  };
}

// A Wednesday: its Monday is 1999-03-08, older than any goal a person has.
const OPENED = "1999-03-10";
const OPENED_MONDAY = "1999-03-08";
const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let habitId: string;
let retiredId: string;
let factDays: string[];
let today: string;
let q: {
  day: typeof import("@/lib/queries/day");
  week: typeof import("@/lib/queries/week");
  month: typeof import("@/lib/queries/month");
  goal: typeof import("@/lib/queries/goal");
};

before(async () => {
  installStubs(loadCookies());
  q = {
    day: await import("@/lib/queries/day"),
    week: await import("@/lib/queries/week"),
    month: await import("@/lib/queries/month"),
    goal: await import("@/lib/queries/goal"),
  };
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const person = await getPerson();
  if (!person) throw new Error("habito-suelto-readers.ts: no verified session");
  today = todayInZone();

  const [habit] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, note, created_at)
    values (${person.id}, null, 'habito-suelto-readers.ts suelto', 'daily', 'tap', 'una nota', ${`${OPENED}T12:00:00-05:00`}::timestamptz)
    returning id`;
  habitId = habit.id;
  const [retired] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, retired_at, created_at)
    values (${person.id}, null, 'habito-suelto-readers.ts retirado', 'daily', 'tap', ${`${OPENED}T20:00:00-05:00`}::timestamptz,
            ${`${OPENED}T12:00:00-05:00`}::timestamptz)
    returning id`;
  retiredId = retired.id;
  factDays = [...new Set([`${today.slice(0, 7)}-01`, today])];
  for (const day of factDays) {
    await db`insert into goals.facts (user_id, commitment_id, day) values (${person.id}, ${habitId}, ${day}::date)`;
  }
});

after(async () => {
  if (habitId) await db`delete from goals.commitments where id = ${habitId}`;
  if (retiredId) await db`delete from goals.commitments where id = ${retiredId}`;
  await db.end();
});

test("Hoy: the loose habit comes apart from every goal, with its slot", async () => {
  const day = await q.day.loadDay(today);
  const loose = day.loose.commitments.find((c) => c.id === habitId);
  assert.ok(loose, "in loose.commitments");
  assert.equal(loose.goalId, null);
  assert.ok(day.loose.slots.some((slot) => slot.commitmentId === habitId), "its slot is in loose.slots");
  assert.ok(day.loose.commitments.every((c) => c.goalId === null), "only loose ones in loose");
  assert.ok(!day.loose.commitments.some((c) => c.id === retiredId), "retired before the day it is not asked");
  assert.ok(!day.goals.some((goal) => goal.id === habitId), "not a goal");
});

test("a day with a loose habit has a first day: the habit's own", async () => {
  const day = await q.day.loadDay(today);
  assert.ok(day.firstGoalDay !== null && day.firstGoalDay <= OPENED);
});

test("Semana: the loose habit comes apart with a tally for each day", async () => {
  const week = await q.week.loadWeek(today);
  assert.ok(week.loose.commitments.some((c) => c.id === habitId && c.goalId === null));
  assert.equal(week.loose.days.length, 7);
  assert.ok(week.loose.days.every((tally) => tally.total >= 1), "a daily habit asks every day");
  assert.ok(week.loose.commitments.every((c) => c.goalId === null));
});

test("Semana reaches back to the Monday of the first loose habit", async () => {
  const week = await q.week.loadWeek(today);
  assert.equal(week.firstMonday, OPENED_MONDAY);
});

test("Mes: the loose habit with the days of the month it was done", async () => {
  const month = await q.month.loadMonthAcross(today);
  const habit = month.loose.find((entry) => entry.id === habitId);
  assert.ok(habit);
  assert.equal(habit.daysDone, factDays.length);
  assert.ok(!month.loose.some((entry) => entry.id === retiredId), "retired long before the month");
});

test("listLooseCommitments: live and retired, with cadence and note", async () => {
  const list = await q.goal.listLooseCommitments();
  const live = list.find((c) => c.id === habitId);
  const retired = list.find((c) => c.id === retiredId);
  assert.ok(live && retired);
  assert.deepEqual(live.cadence, { kind: "daily" });
  assert.equal(live.note, "una nota");
  assert.equal(live.retiredAt === null, true);
  assert.equal(live.factDayCount, factDays.length);
  assert.notEqual(retired.retiredAt, null);
  assert.equal(retired.note, null);
});
