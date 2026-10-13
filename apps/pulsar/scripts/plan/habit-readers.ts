// `loadHabit` (`lib/queries/habit.ts`, RP-105) and the habit's months beside Mes's count. Statements
// are counted off the driver's own wire; the pooler plants every row, dated from the plant, and
// deletes each by its exact id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

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
