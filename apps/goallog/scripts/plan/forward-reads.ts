// Drives the reads «Semana» stepping forward and «Mes» stepping both ways stand on (RP-142): `loadWeek`'s
// `lastMonday` and dated `tasks`, `loadMonthAcross` for a coming and a closed month, and `scheduleOneOff`'s
// revalidation. People are made through the registry and driven with `actAs`; the admin pool seeds what no
// action writes, and every fixture goal is deleted by its exact id.
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
  max: 2,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const revalidated: string[] = [];

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath: (path: string) => void revalidated.push(path) };
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let week: typeof import("@/lib/queries/week");
let month: typeof import("@/lib/queries/month");
let plan: typeof import("@/app/actions/plan");
let oneOffs: typeof import("@/app/actions/one-offs");
let roadmapRead: typeof import("@/lib/plan/roadmap-read");
let limits: typeof import("@/lib/plan/forward-limit");
let zone: typeof import("@/lib/zone");
let owner: Person;
let capped: Person;
let bare: Person;
let today: string;
let thisMonth: string;
let nextMonday: string;
const goalIds: string[] = [];
const ids: Record<string, string> = {};

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

// "YYYY-MM-01" `delta` months from the first of today's month.
function monthFrom(delta: number): string {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

async function goal(person: Person, name: string, horizon: string | null): Promise<string> {
  const created = await as(person, () => plan.createGoal({ name, horizon }));
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalIds.push(created.goalId);
  return created.goalId;
}

// A goal that measures in time at `rhythm` a month, opened on the first of `openedIn`'s month.
async function timed(id: string, rhythm: number, openedIn: string): Promise<void> {
  await admin`
    update goals.goals
    set measure_name = 'minutos', measure_unit = 'minutos', rhythm = ${rhythm},
        created_at = ${`${openedIn}T00:00:00-05:00`}
    where id = ${id}`;
}

async function oneOff(
  person: Person,
  goalId: string | null,
  name: string,
  set: { day?: string; month?: string; estimate?: number; parent?: string; done?: string },
): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, planned_month, estimate, parent_id, in_plan)
    values (${person.id}, ${goalId}, ${name}, ${set.day ?? null}, ${set.month ?? null}, ${set.estimate ?? null},
            ${set.parent ?? null}, ${goalId !== null && set.day === undefined})
    returning id`;
  if (set.done) {
    await admin`
      insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${row.id}, ${set.done}::date)`;
  }
  return row.id;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  week = await import("@/lib/queries/week");
  month = await import("@/lib/queries/month");
  plan = await import("@/app/actions/plan");
  oneOffs = await import("@/app/actions/one-offs");
  roadmapRead = await import("@/lib/plan/roadmap-read");
  limits = await import("@/lib/plan/forward-limit");
  zone = await import("@/lib/zone");
  today = zone.todayInZone();
  thisMonth = `${today.slice(0, 7)}-01`;
  nextMonday = zone.addWeeksToCivilDate(zone.weekOf(today)[0], 1);
  const runId = await openCheckRun(admin);
  [owner, capped, bare] = await createPeople(admin, runId, door, 3);

  // A: 12 a month over three months, 30 of tasks, so the plan spills into the next month.
  ids.a = await goal(owner, "o7-m8 A", monthFrom(3));
  await timed(ids.a, 12, thisMonth);
  ids.a1 = await oneOff(owner, ids.a, "A1", { estimate: 10 });
  ids.a2 = await oneOff(owner, ids.a, "A2", { estimate: 10 });
  ids.a3 = await oneOff(owner, ids.a, "A3", { estimate: 10 });

  // B ends this month, so next month does not hold it.
  ids.b = await goal(owner, "o7-m8 B", monthFrom(1));
  await timed(ids.b, 8, thisMonth);

  // C has no end and was opened two months back: last month is a closed one.
  ids.c = await goal(owner, "o7-m8 C", null);
  await timed(ids.c, 20, monthFrom(-2));
  const commitment = await as(owner, () =>
    plan.addCommitment({
      goalId: ids.c,
      name: "o7-m8 C cantidad",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit: "minutos",
    }),
  );
  if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
  const lastMonth = monthFrom(-1);
  await admin`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.id}, ${ids.c}, ${commitment.commitmentId}, ${`${lastMonth.slice(0, 7)}-15`}, 45)`;
  ids.p1 = await oneOff(owner, ids.c, "P1 hecha", { month: lastMonth, estimate: 5, done: `${lastMonth.slice(0, 7)}-10` });
  ids.p2 = await oneOff(owner, ids.c, "P2 sin hacer", { month: lastMonth, estimate: 7 });

  // Dated one-offs next Wednesday: open, done, and a parent.
  const wednesday = zone.weekOf(nextMonday)[2];
  ids.open = await oneOff(owner, ids.a, "abierta", { day: wednesday });
  await admin`update goals.one_offs set note = 'una nota' where id = ${ids.open}`;
  ids.done = await oneOff(owner, ids.a, "hecha", { day: wednesday, done: today });
  ids.parent = await oneOff(owner, ids.a, "madre", { day: wednesday });
  ids.child = await oneOff(owner, ids.a, "hija", { parent: ids.parent });
  ids.loose = await oneOff(owner, null, "suelta", { day: wednesday });
  // The week's first and last days hold their tasks, listed by day.
  const [monday, , , , , , sunday] = zone.weekOf(nextMonday);
  ids.monday = await oneOff(owner, ids.a, "lunes", { day: monday });
  ids.sunday = await oneOff(owner, ids.a, "domingo", { day: sunday });
  // D ends on that Wednesday: a task dated its last day's morrow is past its span.
  ids.d = await goal(owner, "o7-m8 D", wednesday);
  ids.ended = await oneOff(owner, ids.d, "fuera de D", { day: wednesday });
  // A fact on this month's first day: last month's reached never reads it.
  await admin`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.id}, ${ids.c}, ${commitment.commitmentId}, ${thisMonth}, 30)`;
  // Loose habits: one opened two months back, one this month.
  const [old] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${owner.id}, null, 'o7-m8 suelto viejo', 'daily', 'tap', ${`${monthFrom(-2)}T12:00:00-05:00`}) returning id`;
  const [fresh] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${owner.id}, null, 'o7-m8 suelto nuevo', 'daily', 'tap', ${`${thisMonth}T12:00:00-05:00`}) returning id`;
  ids.oldHabit = old.id;
  ids.freshHabit = fresh.id;

  // `capped` has one goal ending in three months; `bare` has none.
  ids.x = await goal(capped, "o7-m8 X", monthFrom(3));
  // An archived goal reaching further never stretches the limit.
  ids.gone = await goal(capped, "o7-m8 archivada", monthFrom(20));
  await admin`update goals.goals set archived_at = now() where id = ${ids.gone}`;
  // A loose habit opened four months back is what `capped` first opened.
  const [early] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${capped.id}, null, 'o7-m8 suelto de X', 'daily', 'tap', ${`${monthFrom(-4)}T12:00:00-05:00`}) returning id`;
  ids.earlyHabit = early.id;
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await admin`delete from goals.one_offs where id in ${admin([ids.loose])}`;
    await admin`delete from goals.commitments where id in ${admin([ids.oldHabit, ids.freshHabit, ids.earlyHabit])}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

const names = (items: { task: { name: string } }[]) => items.map((item) => item.task.name);

test("Dated tasks: a not-done one-off dated next week is in tasks, by day, Monday to Sunday; done, parent and a task past its goal's span are not", async () => {
  const read = await as(owner, () => week.loadWeek(nextMonday));
  const byName = new Map(read.tasks.map((task) => [task.name, task]));
  assert.deepEqual([...byName.keys()].sort(), ["abierta", "domingo", "lunes", "suelta"]);
  assert.equal(read.tasks[0].name, "lunes");
  assert.equal(read.tasks.at(-1)?.name, "domingo");
  assert.deepEqual(byName.get("abierta"), {
    id: ids.open,
    name: "abierta",
    day: byName.get("abierta")!.day,
    goalId: ids.a,
    goalName: "o7-m8 A",
    note: "una nota",
  });
  assert.equal(byName.get("suelta")?.goalId, null);
  assert.equal(byName.get("suelta")?.goalName, null);
  assert.ok(!read.tasks.some((task) => [ids.done, ids.parent].includes(task.id)), "done and parent stay out");
});

test("Dated tasks: nothing dated in this week's own days leaks into next week", async () => {
  const read = await as(owner, () => week.loadWeek(today));
  assert.deepEqual(read.tasks, []);
});

test("Week: a coming week reads no evidence and asks nothing done", async () => {
  const read = await as(owner, () => week.loadWeek(nextMonday));
  assert.equal(read.evidence, "read");
  assert.deepEqual(read.oneOffFacts, []);
  assert.equal(read.view.start, nextMonday);
});

test("Limit: lastMonday follows the furthest open goal, a goal with no end and no goal at all", async () => {
  const lastMondayOf = (delta: number) => limits.lastMondayOf(monthFrom(delta).slice(0, 7));
  assert.equal((await as(owner, () => week.loadWeek(today))).lastMonday, lastMondayOf(11));
  assert.equal((await as(capped, () => week.loadWeek(today))).lastMonday, lastMondayOf(2));
  assert.equal((await as(bare, () => week.loadWeek(today))).lastMonday, lastMondayOf(0));
  assert.equal((await as(owner, () => month.loadMonthAcross({ today }))).lastMonth, monthFrom(11).slice(0, 7));
  assert.equal((await as(capped, () => month.loadMonthAcross({ today }))).lastMonth, monthFrom(2).slice(0, 7));
  assert.equal((await as(bare, () => month.loadMonthAcross({ today }))).lastMonth, thisMonth.slice(0, 7));
});

test("Month: firstMonth is the month the first goal or loose habit was opened", async () => {
  assert.equal((await as(owner, () => month.loadMonthAcross({ today }))).firstMonth, monthFrom(-2).slice(0, 7));
  assert.equal((await as(capped, () => month.loadMonthAcross({ today }))).firstMonth, monthFrom(-4).slice(0, 7));
  assert.equal((await as(bare, () => month.loadMonthAcross({ today }))).firstMonth, null);
});

test("Placement: a 12 a month goal with 30 of tasks holds in next month what planMonthList gives it", async () => {
  const next = await as(owner, () => month.loadMonthAcross({ month: monthFrom(1), today }));
  assert.equal(next.view, "coming");
  assert.equal(next.month, monthFrom(1));
  const a = next.goals.find((entry) => entry.id === ids.a)!;
  assert.ok(a, "A is open next month");
  assert.deepEqual(
    a.items.map((item) => item.task.id),
    roadmapRead.planMonthList(a.plan, monthFrom(1)).map((item) => item.task.id),
  );
  assert.equal(a.line?.planned, 12);
  assert.equal(a.line?.reached, 0);
  assert.equal(a.items.reduce((sum, item) => sum + item.part, 0), 12);
  assert.ok(names(a.items).length > 0);
});

test("Placement: a task fixed to a coming month is listed there", async () => {
  const fixed = await oneOff(owner, ids.a, "fijada", { month: monthFrom(2), estimate: 1 });
  const later = await as(owner, () => month.loadMonthAcross({ month: monthFrom(2), today }));
  assert.ok(names(later.goals.find((entry) => entry.id === ids.a)!.items).includes("fijada"));
  await admin`delete from goals.one_offs where id = ${fixed}`;
});

test("Out of span: a goal ending this month is absent from next month and present in this one", async () => {
  const next = await as(owner, () => month.loadMonthAcross({ month: monthFrom(1), today }));
  assert.ok(!next.goals.some((entry) => entry.id === ids.b));
  const current = await as(owner, () => month.loadMonthAcross({ today }));
  assert.equal(current.view, "this");
  assert.ok(current.goals.some((entry) => entry.id === ids.b));
});

test("Past month: last month reads its reached amount and its tasks' done state as stored", async () => {
  const past = await as(owner, () => month.loadMonthAcross({ month: monthFrom(-1), today }));
  assert.equal(past.view, "past");
  const c = past.goals.find((entry) => entry.id === ids.c)!;
  assert.ok(c, "C was open last month");
  assert.equal(c.line?.reached, 45);
  assert.equal(c.line?.planned, 20);
  const done = new Map(c.items.map((item) => [item.task.name, item.done]));
  assert.equal(done.get("P1 hecha"), true);
  assert.equal(done.get("P2 sin hacer"), false);
  assert.ok(!past.goals.some((entry) => entry.id === ids.a), "A was opened this month");
});

test("Loose habits: a closed month lists the ones opened by its end; a coming month lists none", async () => {
  const past = await as(owner, () => month.loadMonthAcross({ month: monthFrom(-1), today }));
  const pastNames = past.loose.map((habit) => habit.name);
  assert.ok(pastNames.includes("o7-m8 suelto viejo"), JSON.stringify(pastNames));
  assert.ok(!pastNames.includes("o7-m8 suelto nuevo"), JSON.stringify(pastNames));
  const coming = await as(owner, () => month.loadMonthAcross({ month: monthFrom(1), today }));
  assert.deepEqual(coming.loose, []);
});

test("Past month: a month before the first goal reads no goal", async () => {
  const past = await as(owner, () => month.loadMonthAcross({ month: monthFrom(-3), today }));
  assert.deepEqual(past.goals, []);
});

test("Month: a bare string still means today, and `month` takes YYYY-MM", async () => {
  const bareString = await as(owner, () => month.loadMonthAcross(today));
  assert.equal(bareString.view, "this");
  const named = await as(owner, () => month.loadMonthAcross({ month: monthFrom(1).slice(0, 7), today }));
  assert.equal(named.month, monthFrom(1));
});

test("Statements: a coming week, a coming month and a closed month pay what this week and this month pay", async () => {
  const count = async <T>(load: () => Promise<T>) => {
    wire.length = 0;
    await as(owner, load);
    const begins = wire.filter((query) => /^\s*begin\s*$/i.test(query)).length;
    return { begins, statements: wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query)).length };
  };
  const base = await count(() => week.loadWeek(today));
  assert.equal(base.begins, 2);
  assert.deepEqual(await count(() => week.loadWeek(nextMonday)), base);
  const baseMonth = await count(() => month.loadMonthAcross({ today }));
  assert.equal(baseMonth.begins, 2);
  assert.deepEqual(await count(() => month.loadMonthAcross({ month: monthFrom(1), today })), baseMonth);
  assert.deepEqual(await count(() => month.loadMonthAcross({ month: monthFrom(-1), today })), baseMonth);
});

test("Revalidate: scheduleOneOff revalidates /semana and /mes", async () => {
  revalidated.length = 0;
  const target = zone.addWeeksToCivilDate(nextMonday, 1);
  assert.deepEqual(await as(owner, () => oneOffs.scheduleOneOff({ oneOffId: ids.open, day: target })), { ok: true });
  assert.ok(revalidated.includes("/semana"), JSON.stringify(revalidated));
  assert.ok(revalidated.includes("/mes"), JSON.stringify(revalidated));
});
