// A goal with no end (RP-99) is open for good in every reader: Hoy, Semana, Mes, the rail and
// the goal's own screen; it is never an ended goal, its months run to eleven past today's, and
// its evidence counts up to today. The expected values are written down from the plant.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { sql as dsql, type SQL } from "drizzle-orm";
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

let planted: { day: string; quantity: number }[] = [];

type ReaderTx = { execute: (query: SQL) => Promise<Array<{ f: string; t: string }>> };

// The real reader's bounds, resolved inside the reading transaction, over planted rows.
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
    if (request === "./reading-lookups") {
      return {
        readReadingLookups: async (args: { from: string | SQL; to: string | SQL; tx: ReaderTx }) => {
          const [bounds] = await args.tx.execute(dsql`select (${args.from})::date as f, (${args.to})::date as t`);
          return planted
            .filter((row) => row.day >= String(bounds.f) && row.day <= String(bounds.t))
            .map((row) => ({ day: row.day, quantity: row.quantity, unit: "searches", labelKey: "sources.readingLookups" }));
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

const OPENED_DAYS_AGO = 70;
const db = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let goalId: string;
let endedId: string;
let today: string;
let openedOn: string;
let userId: string;
let q: {
  day: typeof import("@/lib/queries/day");
  week: typeof import("@/lib/queries/week");
  month: typeof import("@/lib/queries/month");
  goal: typeof import("@/lib/queries/goal");
  oneOffs: typeof import("@/lib/queries/one-offs");
};

before(async () => {
  installStubs(loadCookies());
  q = {
    day: await import("@/lib/queries/day"),
    week: await import("@/lib/queries/week"),
    month: await import("@/lib/queries/month"),
    goal: await import("@/lib/queries/goal"),
    oneOffs: await import("@/lib/queries/one-offs"),
  };
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const person = await getPerson();
  if (!person) throw new Error("sin-final-readers.ts: no verified session");
  userId = person.id;
  today = todayInZone();

  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${userId}, 'sin-final-readers.ts endless', null, 'searches', 'searches',
            now() - ${`${OPENED_DAYS_AGO} days`}::interval)
    returning id`;
  goalId = goal.id;
  const [ended] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${userId}, 'sin-final-readers.ts ended', ${addDays(today, -1)}::date, now() - interval '30 days')
    returning id`;
  endedId = ended.id;
  const [source] = await db<{ id: string }[]>`select id from goals.evidence_sources where key = 'reading_lookups'`;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold)
    values (${userId}, ${goalId}, 'sin-final-readers.ts lectura', 'daily', 'evidence', ${source.id}, 1)`;
  const [row] = await db<{ day: string }[]>`
    select (created_at at time zone 'America/Bogota')::date::text as day from goals.goals where id = ${goalId}`;
  openedOn = row.day;
});

after(async () => {
  if (goalId) await db`delete from goals.goals where id = ${goalId}`;
  if (endedId) await db`delete from goals.goals where id = ${endedId}`;
  await db.end();
});

test("Hoy: a goal with no end is open", async () => {
  const day = await q.day.loadDay(today);
  assert.ok(day.goals.some((goal) => goal.id === goalId), "in goals");
  assert.equal(day.goals.find((goal) => goal.id === goalId)?.horizon, null);
  assert.ok(!day.endedThisWeek.some((goal) => goal.id === goalId), "never ended this week");
  assert.notEqual(day.lastEnded?.name, "sin-final-readers.ts endless");
  assert.ok(day.endedThisWeek.some((goal) => goal.id === endedId) || day.lastEnded !== null, "the dated one still ends");
});

test("Semana: a goal with no end is open", async () => {
  const week = await q.week.loadWeek(today);
  assert.equal(week.goals.find((goal) => goal.id === goalId)?.horizon, null);
});

test("Mes: a goal with no end is across", async () => {
  const month = await q.month.loadMonthAcross(today);
  const goal = month.goals.find((entry) => entry.id === goalId);
  assert.ok(goal, "in goals");
  assert.equal(goal.open, true);
  assert.equal(goal.plan.horizon, null);
});

test("never ended: metas lists it open, not ended; the goal has no end day", async () => {
  const metas = await q.goal.listGoalsForMetas(today);
  assert.ok(metas.open.some((goal) => goal.id === goalId), "open");
  assert.ok(!metas.ended.some((goal) => goal.id === goalId), "not ended");
  assert.ok(metas.ended.some((goal) => goal.id === endedId), "the dated one ended");
  const view = await q.goal.loadGoal(goalId, today);
  assert.ok(view);
  assert.equal(view.endedOn, null);
  assert.equal(view.horizon, null);
});

test("the rail lists a goal with no end", async () => {
  const rail = await q.goal.listGoals();
  assert.ok(rail.some((goal) => goal.id === goalId));
  assert.ok(!rail.some((goal) => goal.id === endedId));
});

test("its months run from the opening to eleven past today's", async () => {
  // A `today` that is not the clock's, so a reader that forgets to pass it shows.
  const later = addDays(today, 120);
  const view = await q.goal.loadGoal(goalId, later);
  assert.ok(view);
  const months = view.months.map((row) => row.month);
  assert.equal(months[0], `${openedOn.slice(0, 7)}-01`);
  assert.equal(months[months.length - 1], monthFrom(later, 11));
});

test("its evidence counts from the opening up to today", async () => {
  planted = [
    { day: openedOn, quantity: 1 },
    { day: today, quantity: 1 },
    { day: addDays(today, 1), quantity: 1 },
  ];
  const view = await q.goal.loadGoal(goalId, today);
  assert.ok(view);
  assert.equal(view.measureTotal, 2);
});

test("a goal with no end that holds goals runs its months to eleven past today's", async () => {
  // Same `later` as above: the months of a parent are drawn from the rolled-up figures, not goalFigures'.
  const [parent] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${userId}, 'sin-final-readers.ts parent', null, 'searches', 'searches', now() - interval '70 days')
    returning id`;
  await db`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
    values (${userId}, 'sin-final-readers.ts child', null, 'searches', 'searches', ${parent.id}, now() - interval '60 days')`;
  try {
    const later = addDays(today, 120);
    const view = await q.goal.loadGoal(parent.id, later);
    assert.ok(view);
    const months = view.months.map((row) => row.month);
    assert.equal(months[months.length - 1], monthFrom(later, 11));
  } finally {
    await db`delete from goals.goals where parent_id = ${parent.id}`;
    await db`delete from goals.goals where id = ${parent.id}`;
  }
});

test("the tasks scheduled ahead on a goal with no end are listed; those on an ended goal are not", async () => {
  const ahead = addDays(today, 3);
  const [kept] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day) values (${userId}, ${goalId}, 'sin-final-readers.ts adelante', ${ahead}::date) returning id`;
  const [dropped] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day) values (${userId}, ${endedId}, 'sin-final-readers.ts de la terminada', ${ahead}::date) returning id`;
  try {
    const scheduled = await q.oneOffs.listScheduledOneOffs(today);
    assert.ok(scheduled.some((task) => task.id === kept.id), "the endless goal's task is listed");
    assert.ok(!scheduled.some((task) => task.id === dropped.id), "the ended goal's task is not");
  } finally {
    await db`delete from goals.one_offs where id in (${kept.id}, ${dropped.id})`;
  }
});

test("Mes: a goal with no end adds up the month of a goal inside it that has ended", async () => {
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const [parent] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${userId}, 'sin-final-readers.ts madre abierta', null, 'searches', 'searches', now() - interval '70 days') returning id`;
  const [child] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit, created_at)
    values (${userId}, 'sin-final-readers.ts hija terminada', ${firstOfMonth}::date, ${parent.id}, 'searches', 'searches', now() - interval '60 days')
    returning id`;
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${userId}, ${child.id}, ${firstOfMonth}::date, 7)`;
  try {
    const month = await q.month.loadMonthAcross(today);
    const holder = month.goals.find((entry) => entry.id === parent.id);
    assert.ok(holder, "the open parent");
    assert.ok(!month.goals.some((entry) => entry.id === child.id), "the ended goal is not drawn");
    assert.equal(holder.line?.planned, 7, "what the ended goal planned this month adds to the one above");
  } finally {
    await db`delete from goals.month_budgets where goal_id = ${child.id}`;
    await db`delete from goals.goals where id = ${child.id}`;
    await db`delete from goals.goals where id = ${parent.id}`;
  }
});
