// `loadHabit` (`lib/queries/habit.ts`, RP-105) and the habit's months beside Mes's count. Statements
// are counted off the driver's own wire; the pooler plants every row, dated from the plant, and
// deletes each by its exact id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

import type { MonthLooseHabit } from "@/lib/queries/month";
import { readWire, wrapPostgres, type DebugCall, type PostgresFactory } from "./wire";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

const lane = laneNumber();
const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;

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

const wireCalls: DebugCall[] = [];

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
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      return wrapPostgres(real, (call) => wireCalls.push(call));
    }
    return originalLoad(request, parent, isMain);
  };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

// The habit's own timeline is fixed; only Mes's figures hang from the real today.
const CREATED = "2026-08-20";
const AT = "2026-10-13";

const commitmentIds: string[] = [];
const goalIds: string[] = [];
let userId: string;
let habitId: string;
let retiredId: string;
let goalCommitmentId: string;
let foreignId: string;
let today: string;
let monthStart: string;
let mes: Record<string, string> = {};
let e4Id: string;
let weeklyMesId: string;
let e3Id: string;
let e4NadarId: string;
let e5Id: string;
let e5cId: string;
let h2Id: string;
let h3Id: string;
let q: {
  habit: typeof import("@/lib/queries/habit");
  month: typeof import("@/lib/queries/month");
};

async function plant(
  owner: string,
  name: string,
  columns: { kind?: string; n?: number | null; weekdays?: number[] | null; createdAt: string; retiredAt?: string | null; goalId?: string | null },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, cadence_weekdays, satisfaction, created_at, retired_at)
    values (${owner}, ${columns.goalId ?? null}, ${name}, ${columns.kind ?? "daily"}, ${columns.n ?? null},
            ${columns.weekdays ?? null}, 'tap', ${columns.createdAt}::timestamptz, ${columns.retiredAt ?? null}::timestamptz)
    returning id`;
  commitmentIds.push(row.id);
  return row.id;
}

async function done(commitment: string, days: string[]): Promise<void> {
  for (const day of days) {
    await sql`insert into goals.facts (user_id, commitment_id, day) values (${userId}, ${commitment}, ${day}::date)`;
  }
}

before(async () => {
  installStubs(loadCookies());
  q = { habit: await import("@/lib/queries/habit"), month: await import("@/lib/queries/month") };
  const { getPerson } = await import("@/lib/session");
  const { todayInZone } = await import("@/lib/zone");
  const person = await getPerson();
  if (!person) throw new Error("habit-readers.ts: no verified session");
  userId = person.id;
  today = todayInZone();
  monthStart = `${today.slice(0, 7)}-01`;

  habitId = await plant(userId, "habit-readers.ts diario", { createdAt: `${CREATED}T12:00:00-05:00` });
  await done(habitId, ["2026-09-02", "2026-09-10", "2026-09-11", "2026-09-30", "2026-10-02"]);
  retiredId = await plant(userId, "habit-readers.ts retirado", {
    createdAt: `${CREATED}T12:00:00-05:00`,
    retiredAt: "2026-09-08T12:00:00-05:00",
  });
  await done(retiredId, ["2026-08-25"]);

  const [goal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${userId}, 'habit-readers.ts meta', null) returning id`;
  goalIds.push(goal.id);
  goalCommitmentId = await plant(userId, "habit-readers.ts de una meta", { createdAt: `${CREATED}T12:00:00-05:00`, goalId: goal.id });

  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no member identity — run harness:token for this lane");
  foreignId = await plant(member.id, "habit-readers.ts ajeno", { createdAt: `${CREATED}T12:00:00-05:00` });

  // E4: the split week, in fixed days of 2025.
  e4Id = await plant(userId, "habit-readers.ts E4 semanal", { createdAt: "2025-09-15T12:00:00-05:00", kind: "times_per_week", n: 1 });
  await done(e4Id, ["2025-09-16", "2025-09-30", "2025-10-08", "2025-10-15", "2025-10-29"]);
  // Mon 28 Sep 2026 is the week of October (its Thursday is the 1st): the fact is September's by day, October's by week.
  weeklyMesId = await plant(userId, "habit-readers.ts mes semana partida", {
    createdAt: "2026-09-01T12:00:00-05:00",
    kind: "times_per_week",
    n: 1,
  });
  await done(weeklyMesId, ["2026-09-28"]);

  // E3, E6: a weekly habit made every week since July, done Mon 26 Oct and Mon 12 Oct.
  e3Id = await plant(userId, "habit-readers.ts E3 llamar", { createdAt: "2026-07-08T12:00:00-05:00", kind: "times_per_week", n: 1 });
  await done(e3Id, ["2026-09-29", "2026-10-06", "2026-10-12", "2026-10-26"]);
  // E4: made and done on the day.
  e4NadarId = await plant(userId, "habit-readers.ts E4 nadar", { createdAt: "2026-10-13T08:00:00-05:00", kind: "times_per_week", n: 2 });
  await done(e4NadarId, ["2026-10-13"]);
  // E5: retired Wed 7 Oct 2026, the week of the 5th met before it.
  e5Id = await plant(userId, "habit-readers.ts E5 yoga", {
    createdAt: "2026-08-17T12:00:00-05:00",
    kind: "times_per_week",
    n: 2,
    retiredAt: "2026-10-07T12:00:00-05:00",
  });
  await done(e5Id, ["2026-08-17", "2026-08-18", "2026-08-24", "2026-08-25", "2026-08-31", "2026-09-01", "2026-09-07", "2026-09-08",
    "2026-09-14", "2026-09-15", "2026-09-29", "2026-09-30", "2026-10-05", "2026-10-06"]);
  // E5c: retired Tue 29 Sep, whose week's Thursday is October's but which was met.
  e5cId = await plant(userId, "habit-readers.ts E5c retiro", {
    createdAt: "2026-09-07T12:00:00-05:00",
    kind: "times_per_week",
    n: 1,
    retiredAt: "2026-09-29T12:00:00-05:00",
  });
  await done(e5cId, ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  // H2: daily, made Mon 5 Oct, nothing done, retired Tue 6 Oct.
  h2Id = await plant(userId, "habit-readers.ts H2 leer", { createdAt: "2026-10-05T12:00:00-05:00", retiredAt: "2026-10-06T12:00:00-05:00" });
  // H3: weekly, retired Tue 13 Oct at 23:30 Bogotá, which is the 14th in UTC.
  h3Id = await plant(userId, "habit-readers.ts H3 tarde", {
    createdAt: "2026-09-07T12:00:00-05:00",
    kind: "times_per_week",
    n: 1,
    retiredAt: "2026-10-13T23:30:00-05:00",
  });

  // Opened on the 1st at Bogotá's midnight, so day d of the month asks d times of a daily habit.
  const opened = `${monthStart}T00:00:00-05:00`;
  mes = {
    daily: await plant(userId, "habit-readers.ts mes diario", { createdAt: opened }),
    weekdays: await plant(userId, "habit-readers.ts mes lun-vie", { createdAt: opened, kind: "weekdays", weekdays: [1, 2, 3, 4, 5] }),
    everyN: await plant(userId, "habit-readers.ts mes cada 3", { createdAt: opened, kind: "every_n_days", n: 3 }),
    perWeek: await plant(userId, "habit-readers.ts mes semanal", { createdAt: opened, kind: "times_per_week", n: 2 }),
    perMonth: await plant(userId, "habit-readers.ts mes mensual", { createdAt: opened, kind: "times_per_month", n: 4 }),
  };
});

after(async () => {
  if (commitmentIds.length > 0) await sql`delete from goals.commitments where id in ${sql(commitmentIds)}`;
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("loadHabit: months from the creation to today, the done days of each", async () => {
  const habit = await q.habit.loadHabit(habitId, AT);
  assert.ok(habit);
  assert.equal(habit.name, "habit-readers.ts diario");
  assert.equal(habit.createdOn, CREATED);
  assert.equal(habit.retiredOn, null);
  assert.equal(habit.note, null);
  assert.deepEqual(habit.cadence, { kind: "daily" });
  assert.equal(habit.factDayCount, 5);
  assert.deepEqual(
    habit.months.map(({ month, daysDone, asked, current }) => ({ month, daysDone, asked, current })),
    [
      { month: "2026-08-01", daysDone: 0, asked: 12, current: false },
      { month: "2026-09-01", daysDone: 4, asked: 30, current: false },
      { month: "2026-10-01", daysDone: 1, asked: 13, current: true },
    ],
  );
});

test("loadHabit: a retired habit ends in the month it was retired", async () => {
  const habit = await q.habit.loadHabit(retiredId, AT);
  assert.ok(habit);
  assert.equal(habit.retiredOn, "2026-09-08");
  assert.deepEqual(habit.months.map((m) => m.month), ["2026-08-01", "2026-09-01"]);
  assert.equal(habit.months[1].asked, 8);
  assert.equal(habit.months[0].daysDone, 1);
});

test("loadHabit: a goal's commitment, another person's and a missing one are null", async () => {
  assert.equal(await q.habit.loadHabit(goalCommitmentId, AT), null);
  assert.equal(await q.habit.loadHabit(foreignId, AT), null);
  assert.equal(await q.habit.loadHabit("00000000-0000-4000-8000-000000000000", AT), null);
});

test("loadHabit: a bad id is null and sends nothing", async () => {
  const before = wireCalls.length;
  assert.equal(await q.habit.loadHabit("x", AT), null);
  assert.equal(await q.habit.loadHabit("", AT), null);
  assert.equal(wireCalls.length, before);
});

test("loadHabit: one application statement", async () => {
  await q.habit.loadHabit(habitId, AT);
  const before = wireCalls.length;
  await q.habit.loadHabit(habitId, AT);
  const calls = wireCalls.slice(before);
  const wire = readWire(calls);
  assert.equal(wire.connections, 1);
  // The session's own settle precedes the read in every transaction; selects that read goals are the read.
  const reads = calls.filter((call) => /\bselect\b/i.test(call.query) && /"goals"\."/.test(call.query));
  assert.equal(reads.length, 1);
  assert.equal(wire.applicationStatements, 2);
});

// The expected asks are counted day by day here, not by the shared function.
function daysOfMonthTo(day: string): string[] {
  const last = Number(day.slice(8, 10));
  return Array.from({ length: last }, (_, i) => `${day.slice(0, 7)}-${String(i + 1).padStart(2, "0")}`);
}

function isoWeekday(day: string): number {
  const native = new Date(`${day}T00:00:00Z`).getUTCDay();
  return native === 0 ? 7 : native;
}

test("Mes: the five cadences count what they always counted", async () => {
  const days = daysOfMonthTo(today);
  const month = await q.month.loadMonthAcross(today);
  const asked = (id: string) => month.loose.find((entry) => entry.id === id)?.asked;
  assert.equal(asked(mes.daily), days.length);
  assert.equal(asked(mes.weekdays), days.filter((d) => isoWeekday(d) <= 5).length);
  assert.equal(asked(mes.everyN), days.filter((_, i) => i % 3 === 0).length);
  assert.equal(asked(mes.perWeek), null);
  assert.equal(asked(mes.perMonth), null);
});

test("the habit's current month asks what Mes asks", async () => {
  const month = await q.month.loadMonthAcross(today);
  for (const key of ["daily", "weekdays", "everyN", "perWeek", "perMonth"]) {
    const habit = await q.habit.loadHabit(mes[key], today);
    assert.ok(habit);
    const current = habit.months.at(-1)!;
    assert.equal(current.month, monthStart);
    assert.equal(current.asked, month.loose.find((entry) => entry.id === mes[key])?.asked, key);
  }
});

test("loadHabit: E4, the weeks of a weekly habit by their Thursday, in one statement", async () => {
  await q.habit.loadHabit(e4Id, AT);
  const before = wireCalls.length;
  const habit = await q.habit.loadHabit(e4Id, AT);
  assert.ok(habit);
  const calls = wireCalls.slice(before);
  const reads = calls.filter((call) => /\bselect\b/i.test(call.query) && /"goals"\."/.test(call.query));
  assert.equal(reads.length, 1);
  assert.equal(readWire(calls).applicationStatements, 2);
  const byMonth = new Map(habit.months.map((m) => [m.month, m.weeks]));
  assert.deepEqual(byMonth.get("2025-09-01"), { met: 1, counted: 2 });
  assert.deepEqual(byMonth.get("2025-10-01"), { met: 4, counted: 5 });
});

test("loadHabit: a daily habit has no weeks and asks what it asked", async () => {
  const habit = await q.habit.loadHabit(habitId, AT);
  assert.ok(habit);
  assert.ok(habit.months.every((m) => m.weeks === null));
  assert.deepEqual(habit.months.map((m) => m.asked), [12, 30, 13]);
});

test("Mes: the week that starts in the month before counts, the days of the month do not", async () => {
  const month = await q.month.loadMonthAcross(AT);
  const habit = month.loose.find((entry) => entry.id === weeklyMesId);
  assert.ok(habit);
  assert.deepEqual(habit.weeks, { met: 1, counted: 2 });
  assert.equal(habit.daysDone, 0);
  assert.equal(habit.asked, null);
  const daily = month.loose.find((entry) => entry.id === habitId);
  assert.equal(daily?.weeks, null);
  assert.equal(daily?.daysDone, 1);
});

test("Mes: the weeks are the ones the habit's own screen draws", async () => {
  const month = await q.month.loadMonthAcross(AT);
  const screen = await q.habit.loadHabit(weeklyMesId, AT);
  assert.ok(screen);
  assert.deepEqual(month.loose.find((entry) => entry.id === weeklyMesId)?.weeks, screen.months.at(-1)!.weeks);
});

test("Mes: still one statement on the goals schema, whatever the habits", async () => {
  await q.month.loadMonthAcross(AT);
  const before = wireCalls.length;
  await q.month.loadMonthAcross(AT);
  const calls = wireCalls.slice(before);
  const reads = calls.filter((call) => /\bselect\b/i.test(call.query) && /"goals"\."/.test(call.query));
  assert.equal(reads.length, 1);
});

const loose = (month: { loose: MonthLooseHabit[] }, id: string) => month.loose.find((entry) => entry.id === id);

test("Mes E6: the week in progress starts in the month before and is not closed", async () => {
  const habit = loose(await q.month.loadMonthAcross("2026-11-01"), e3Id);
  assert.ok(habit);
  assert.deepEqual(habit.thisWeek, { done: 1, count: 1 });
  assert.deepEqual(habit.weeks, { met: 0, counted: 0 });
});

test("Mes E3: this week beside the weeks of the month", async () => {
  const habit = loose(await q.month.loadMonthAcross(AT), e3Id);
  assert.ok(habit);
  assert.deepEqual(habit.thisWeek, { done: 1, count: 1 });
  assert.deepEqual(habit.weeks, { met: 2, counted: 2 });
});

test("E5: a retired habit counts the week it was retired in, on Mes and on its screen", async () => {
  const habit = loose(await q.month.loadMonthAcross(AT), e5Id);
  assert.ok(habit);
  assert.deepEqual(habit.weeks, { met: 2, counted: 2 });
  assert.equal(habit.thisWeek, null);
  // The day after the retirement the week is still running, and counts anyway.
  const running = loose(await q.month.loadMonthAcross("2026-10-08"), e5Id);
  assert.deepEqual(running?.weeks, { met: 2, counted: 2 });
  const screen = await q.habit.loadHabit(e5Id, AT);
  assert.ok(screen);
  const october = screen.months.at(-1)!;
  assert.equal(october.month, "2026-10-01");
  assert.deepEqual(october.weeks, { met: 2, counted: 2 });
  assert.equal(october.thisWeek, null);
  assert.equal(october.current, false);
});

test("E5c: the retirement week whose Thursday is next month counts in the month of the retirement", async () => {
  const screen = await q.habit.loadHabit(e5cId, AT);
  assert.ok(screen);
  const last = screen.months.at(-1)!;
  assert.equal(last.month, "2026-09-01");
  assert.deepEqual(last.weeks, { met: 4, counted: 4 });
});

test("Mes and the screen hold one week in progress", async () => {
  const month = await q.month.loadMonthAcross(AT);
  for (const [id, expected] of [[e3Id, { done: 1, count: 1 }], [e4NadarId, { done: 1, count: 2 }]] as const) {
    const screen = await q.habit.loadHabit(id, AT);
    assert.ok(screen);
    assert.deepEqual(loose(month, id)?.thisWeek, expected);
    assert.deepEqual(screen.months.at(-1)!.thisWeek, expected);
  }
  assert.deepEqual(loose(month, e4NadarId)?.weeks, { met: 0, counted: 0 });
});

test("a daily habit has no week in progress, and Mes's days are as before", async () => {
  const habit = loose(await q.month.loadMonthAcross(AT), habitId);
  assert.ok(habit);
  assert.equal(habit.thisWeek, null);
  assert.equal(habit.daysDone, 1);
});

test("the week in progress costs no statement: loadHabit one, Mes one", async () => {
  await q.habit.loadHabit(e3Id, AT);
  await q.month.loadMonthAcross(AT);
  const before = wireCalls.length;
  await q.habit.loadHabit(e3Id, AT);
  const mid = wireCalls.length;
  await q.month.loadMonthAcross(AT);
  const goalsReads = (calls: DebugCall[]) => calls.filter((call) => /\bselect\b/i.test(call.query) && /"goals"\."/.test(call.query)).length;
  assert.equal(goalsReads(wireCalls.slice(before, mid)), 1);
  assert.equal(goalsReads(wireCalls.slice(mid)), 1);
});

test("Mes H1: the day a loose habit was retired, null while it lives", async () => {
  const month = await q.month.loadMonthAcross(AT);
  assert.equal(loose(month, e5Id)?.retiredOn, "2026-10-07");
  assert.equal(loose(month, e3Id)?.retiredOn, null);
  assert.equal(loose(month, habitId)?.retiredOn, null);
});

test("Mes H3: the retirement day is Bogotá's, not UTC's", async () => {
  assert.equal(loose(await q.month.loadMonthAcross(AT), h3Id)?.retiredOn, "2026-10-13");
});

test("Mes and the screen hold one retirement day", async () => {
  const month = await q.month.loadMonthAcross(AT);
  for (const id of [e5Id, h2Id]) {
    const screen = await q.habit.loadHabit(id, AT);
    assert.ok(screen);
    assert.equal(screen.retiredOn, loose(month, id)?.retiredOn);
  }
  assert.equal(loose(month, h2Id)?.retiredOn, "2026-10-06");
});

test("Mes H1, H2: the rest of a retired habit is as before", async () => {
  const month = await q.month.loadMonthAcross(AT);
  const yoga = loose(month, e5Id);
  assert.deepEqual(yoga?.weeks, { met: 2, counted: 2 });
  assert.equal(yoga?.thisWeek, null);
  const read = loose(month, h2Id);
  assert.equal(read?.asked, 2);
  assert.equal(read?.daysDone, 0);
});
