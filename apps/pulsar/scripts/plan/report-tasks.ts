// Drives the report's `tasks` (RP-49, RP-47): this month's list as
// «Mes» reads it, done and not, in plan order. Rows are planted by direct SQL
// with explicit positions that run against creation order;
// the session `harness:mint-session` left standing, `server-only`,
// `next/headers` and `next/cache` stubbed before the first `@/` import.
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
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

const goalIds: string[] = [];
let today: string;
let userId: string;
let loadReport: typeof import("@/lib/queries/report").loadReport;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  ({ loadReport } = await import("@/lib/queries/report"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const horizon = `${monthFrom(today, 2)}-01`;
  const first = await plan.createGoal({ name: "RP-49 fixture: primera", horizon });
  const second = await plan.createGoal({ name: "RP-49 fixture: segunda", horizon });
  if (!first.ok || !second.ok) throw new Error("createGoal failed");
  goalIds.push(first.goalId, second.goalId);
  [{ user_id: userId }] = await sql<{ user_id: string }[]>`
    select user_id from goals.goals where id = ${first.goalId}`;
  // The second goal is planned before the first although it was created after.
  await sql`update goals.goals set position = 2000002 where id = ${first.goalId}`;
  await sql`update goals.goals set position = 2000001 where id = ${second.goalId}`;

  const goalId = first.goalId;
  async function task(
    name: string,
    month: string | null,
    position: number,
    extra: { parent?: string; estimate?: number; note?: string } = {},
  ) {
    const [row] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id, estimate, note, position)
      values (${userId}, ${goalId}, ${name}, ${month}, ${extra.parent ?? null}, ${extra.estimate ?? null},
              ${extra.note ?? null}, ${position})
      returning id`;
    return row.id;
  }
  async function doneOn(id: string, day: string) {
    await sql`insert into goals.facts (user_id, goal_id, one_off_id, day)
              values (${userId}, ${goalId}, ${id}, ${day})`;
  }
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonth = `${monthFrom(today, -1)}-01`;
  // Creation order is the reverse of plan order inside the month.
  const open = await task("RP-49 abierta", thisMonth, 3000020, { note: "RP-49 nota madre" });
  const a = await task("RP-49 hija hecha", null, 3000022, { parent: open, estimate: 30, note: "RP-49 nota hija" });
  await task("RP-49 hija abierta", null, 3000021, { parent: open, estimate: 50 });
  await doneOn(a, today);
  const done = await task("RP-49 hecha", thisMonth, 3000010, { estimate: 25 });
  await doneOn(done, today);
  await task("RP-49 arrastrada", lastMonth, 3000030, { estimate: 40 });
  const closed = await task("RP-49 cerrada el mes pasado", lastMonth, 3000005, { estimate: 15 });
  await doneOn(closed, `${monthFrom(today, -1)}-03`);
});

after(async () => {
  for (const id of goalIds) await sql`delete from goals.goals where id = ${id}`;
  await sql.end();
});

test("loadReport: tasks reads the carried one, then the month's own in plan order, done and not", async () => {
  const report = await loadReport(today);
  const goal = report.goals.find((entry) => entry.id === goalIds[0]);
  assert.ok(goal);
  assert.deepEqual(
    goal.tasks.map((task) => [task.name, task.from, task.done]),
    [
      ["RP-49 arrastrada", `${monthFrom(today, -1)}-01`, false],
      ["RP-49 hecha", null, true],
      ["RP-49 abierta", null, false],
    ],
  );
});

test("loadReport: a done task reads its day, an open parent its sub-tasks in order with state and notes", async () => {
  const report = await loadReport(today);
  const tasks = report.goals.find((entry) => entry.id === goalIds[0])?.tasks ?? [];
  const done = tasks.find((task) => task.name === "RP-49 hecha");
  assert.deepEqual([done?.doneOn, done?.estimate, done?.owes], [today, 25, 0]);
  const open = tasks.find((task) => task.name === "RP-49 abierta");
  assert.ok(open);
  assert.equal(open.note, "RP-49 nota madre");
  assert.deepEqual([open.doneOn, open.estimate, open.owes, open.hasAmount], [null, null, 50, true]);
  assert.deepEqual(open.children, [
    { name: "RP-49 hija abierta", done: false, doneOn: null, estimate: 50, note: null },
    { name: "RP-49 hija hecha", done: true, doneOn: today, estimate: 30, note: "RP-49 nota hija" },
  ]);
});

test("loadReport: carried keeps listing only the undone carried task", async () => {
  const report = await loadReport(today);
  const carried = report.goals.find((entry) => entry.id === goalIds[0])?.carried ?? [];
  assert.deepEqual(
    carried.map((item) => [item.name, item.from, item.owes]),
    [["RP-49 arrastrada", `${monthFrom(today, -1)}-01`, 40]],
  );
});

test("loadReport: goals read in plan order, not creation order", async () => {
  const report = await loadReport(today);
  const index = (id: string) => report.goals.findIndex((entry) => entry.id === id);
  assert.ok(index(goalIds[1]) >= 0 && index(goalIds[1]) < index(goalIds[0]));
});

test("loadReport: a task with no estimate says no part, beside one cut by the month's rhythm that does (RP-49)", async () => {
  const plan = await import("@/app/actions/plan");
  const made = await plan.createGoal({ name: "RP-49 fixture: sin estimado", horizon: `${monthFrom(today, 3)}-01` });
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalIds.push(made.goalId);
  const goalId = made.goalId;
  // Opened on the 1st, Bogotá's midnight: this month plans the whole 20 (RP-74) whatever the run date.
  await sql`update goals.goals set measure_unit = 'minutos', measure_name = 'Tiempo', rhythm = 20,
    created_at = ${`${today.slice(0, 7)}-01T00:00:00-05:00`} where id = ${goalId}`;
  async function task(name: string, position: number, extra: { parent?: string; estimate?: number; month?: boolean } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate, in_plan, planned_month, position)
      values (${userId}, ${goalId}, ${name}, ${extra.parent ?? null}, ${extra.estimate ?? null},
              ${extra.parent ? false : true}, ${extra.month ? `${today.slice(0, 7)}-01` : null}, ${position})
      returning id`;
    return row.id;
  }
  await task("RP-49 sin monto: cortada", 1, { estimate: 30 });
  const mother = await task("RP-49 sin monto: madre", 2, { month: true });
  await task("RP-49 sin monto: hija uno", 3, { parent: mother });
  await task("RP-49 sin monto: hija dos", 4, { parent: mother });
  await task("RP-49 sin monto: suelta", 5, { month: true });

  const report = await loadReport(today);
  const tasks = report.goals.find((entry) => entry.id === goalId)?.tasks ?? [];
  const byName = new Map(tasks.map((item) => [item.name, item]));
  const cut = byName.get("RP-49 sin monto: cortada")!;
  assert.deepEqual([cut.part, cut.continuesIn], [20, `${monthFrom(today, 1)}-01`]);
  for (const name of ["RP-49 sin monto: madre", "RP-49 sin monto: suelta"]) {
    const item = byName.get(name);
    assert.ok(item, `${name} is listed`);
    assert.equal(item.hasAmount, false, name);
    assert.equal(item.part, null, name);
  }
});

test("loadReport: a time goal with no rhythm counts each month's tasks; with a rhythm or another unit it does not (RP-73)", async () => {
  const plan = await import("@/app/actions/plan");
  const horizon = `${monthFrom(today, 4)}-01`;
  async function goal(name: string, unit: string, rhythm: number | null) {
    const made = await plan.createGoal({ name, horizon });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    goalIds.push(made.goalId);
    await sql`update goals.goals set measure_unit = ${unit}, measure_name = 'Medida', rhythm = ${rhythm}
              where id = ${made.goalId}`;
    for (const [offset, count] of [[0, 2], [1, 1], [3, 1]] as const) {
      for (let n = 0; n < count; n++) {
        await sql`
          insert into goals.one_offs (user_id, goal_id, name, in_plan, planned_month, position)
          values (${userId}, ${made.goalId}, ${`RP-73 ${name} ${offset}.${n}`}, true,
                  ${`${monthFrom(today, offset)}-01`}, ${4000000 + offset * 10 + n})`;
      }
    }
    return made.goalId;
  }
  const portfolio = await goal("RP-73 Portafolio", "minutos", null);
  const english = await goal("RP-73 Inglés", "minutos", 20);
  const bike = await goal("RP-73 Bici", "km", null);
  const report = await loadReport(today);
  const months = (id: string) => report.goals.find((entry) => entry.id === id)?.months ?? [];
  assert.deepEqual(
    months(portfolio).slice(0, 4).map((row) => row.tasks),
    [{ done: 0, total: 2 }, { done: 0, total: 1 }, { done: 0, total: 0 }, { done: 0, total: 1 }],
  );
  assert.ok(months(english).length > 0 && months(english).every((row) => !("tasks" in row)), "rhythm: no tasks");
  assert.ok(months(bike).length > 0 && months(bike).every((row) => !("tasks" in row)), "other unit: no tasks");
});
