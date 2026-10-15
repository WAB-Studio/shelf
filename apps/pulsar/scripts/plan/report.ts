// Drives `loadReport` (`lib/queries/report.ts`, RP-49) the way `scripts/check-
// goal.ts` drives `loadGoal`: statements counted off the driver's own wire,
// the session `harness:mint-session` left standing, `server-only`,
// `next/headers` and `next/cache` stubbed before the first `@/` import. Every
// own goal is written through the actions; the pooler plants only what no
// action writes (tasks with an estimate, a done fact, another person's goal)
// and deletes each fixture by its exact id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { proveOverlap, readWire, wrapPostgres, type DebugCall, type PostgresFactory } from "./wire";

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
const STUB_QUANTITIES = [5, 3, 2];
// Flipped per test: the reader answers with known rows, rejects, or is the
// real one (the wire test needs its own statement).
let evidenceRejects = false;
let realReader = false;

function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
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
    if (request === "./reading-lookups") {
      const real = originalLoad(request, parent, isMain) as {
        readReadingLookups: (...args: unknown[]) => Promise<unknown>;
      };
      return {
        readReadingLookups: async (...args: unknown[]) => {
          if (realReader) return real.readReadingLookups(...args);
          if (evidenceRejects) throw new Error("report.ts: simulated reading-lookups failure");
          const day = todayInBogota();
          return STUB_QUANTITIES.map((quantity) => ({
            day,
            quantity,
            unit: "searches",
            labelKey: "sources.readingLookups",
          }));
        },
      };
    }
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      const wrapped = wrapPostgres(real, (call) => wireCalls.push(call));
      return wrapped;
    }
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
let minutesGoalId: string;
let searchesGoalId: string;
let archivedGoalId: string;
let foreignGoalId: string;
let sharesGoalId: string;
let rhythmGoalId: string;
let partialGoalId: string;
let mismatchGoalId: string;
let loadReport: typeof import("@/lib/queries/report").loadReport;
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  const { setMonthBudget } = await import("@/app/actions/budgets");
  const { declareFact } = await import("@/app/actions/facts");
  ({ loadReport } = await import("@/lib/queries/report"));
  ({ loadGoal } = await import("@/lib/queries/goal"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const thisMonth = today.slice(0, 7);
  const horizon = `${monthFrom(today, 2)}-01`;

  async function goal(name: string, unit: string): Promise<{ goalId: string; commitmentId: string }> {
    const created = await plan.createGoal({ name, horizon });
    if (!created.ok) throw new Error(`createGoal: ${created.error}`);
    goalIds.push(created.goalId);
    const commitment = await plan.addCommitment({
      goalId: created.goalId,
      name: "RP-49 fixture: cantidad",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit,
    });
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    return { goalId: created.goalId, commitmentId: commitment.commitmentId };
  }

  const minutes = await goal("RP-49 fixture: minutos", "minutos");
  minutesGoalId = minutes.goalId;
  const searches = await goal("RP-49 fixture: búsquedas", "searches");
  searchesGoalId = searches.goalId;
  const archived = await goal("RP-49 fixture: archivada", "minutos");
  archivedGoalId = archived.goalId;

  for (const [goalId, month, amount] of [
    [minutesGoalId, thisMonth, 720],
    [searchesGoalId, monthFrom(today, 1), 40],
  ] as const) {
    const planted = await setMonthBudget({ goalId, month, amount });
    if (!planted.ok) throw new Error(`setMonthBudget: ${planted.error}`);
  }
  const evidence = await plan.addCommitment({
    goalId: searchesGoalId,
    name: "RP-49 fixture: evidencia",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!evidence.ok) throw new Error(`addCommitment(evidence): ${evidence.error}`);
  const phase = await plan.addPhase({
    goalId: minutesGoalId,
    aim: "RP-49 fixture: fase del plan",
    startsOn: today,
    endsOn: `${monthFrom(today, 1)}-01`,
  });
  if (!phase.ok) throw new Error(`addPhase: ${phase.error}`);
  const fact = await declareFact({ commitmentId: minutes.commitmentId, quantity: 30 });
  if (!fact.ok) throw new Error(`declareFact: ${fact.error}`);

  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from goals.goals where id = ${minutesGoalId}`;
  // A parent planned last month with one undone child (carried into this
  // month), and one done task this month whose estimate counts (RP-36).
  const [parent] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${owner.user_id}, ${minutesGoalId}, 'RP-49 fixture: arrastrada', ${`${monthFrom(today, -1)}-01`})
    returning id`;
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
    values (${owner.user_id}, ${minutesGoalId}, 'RP-49 fixture: hija', ${parent.id}, 40)`;
  const [done] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${owner.user_id}, ${minutesGoalId}, 'RP-49 fixture: hecha', ${`${thisMonth}-01`}, 25)
    returning id`;
  await sql`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${owner.user_id}, ${minutesGoalId}, ${done.id}, ${today})`;

  // A goal opened two months ago, so last month is closed and has a share.
  const shares = await goal("RP-49 fixture: cuota", "minutos");
  sharesGoalId = shares.goalId;
  await sql`
    update goals.goals set created_at = now() - interval '70 days'
    where id = ${sharesGoalId} and user_id = ${owner.user_id}`;
  const lastMonth = `${monthFrom(today, -1)}-01`;
  async function task(name: string, fields: { estimate?: number; parent?: string; month?: boolean }) {
    const [row] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id, estimate)
      values (${owner.user_id}, ${sharesGoalId}, ${name},
              ${fields.month === false ? null : lastMonth}, ${fields.parent ?? null}, ${fields.estimate ?? null})
      returning id`;
    return row.id;
  }
  async function doneOn(id: string, day: string) {
    await sql`insert into goals.facts (user_id, goal_id, one_off_id, day)
              values (${owner.user_id}, ${sharesGoalId}, ${id}, ${day})`;
  }
  await doneOn(await task("RP-49 cuota: hecha", { estimate: 60 }), `${monthFrom(today, -1)}-05`);
  await task("RP-49 cuota: debe", { estimate: 40 });
  const half = await task("RP-49 cuota: mitad", {});
  await doneOn(await task("RP-49 cuota: mitad hecha", { parent: half, month: false, estimate: 10 }), `${monthFrom(today, -1)}-06`);
  await task("RP-49 cuota: mitad pendiente", { parent: half, month: false, estimate: 15 });
  await task("RP-49 cuota: sin monto", {});
  const whole = await task("RP-49 cuota: toda hecha", {});
  await doneOn(await task("RP-49 cuota: toda hecha hija", { parent: whole, month: false, estimate: 20 }), `${monthFrom(today, -1)}-06`);

  // A goal with a rhythm and no month on its tasks: the plan places them.
  const rhythm = await goal("RP-49 fixture: ritmo", "minutos");
  rhythmGoalId = rhythm.goalId;
  // Opened on the 1st, Bogotá's midnight: this month plans the whole 20 (RP-74) whatever the run date.
  await sql`update goals.goals set rhythm = 20, created_at = ${`${thisMonth}-01T00:00:00-05:00`} where id = ${rhythmGoalId}`;
  for (const [position, name, estimate] of [
    [1, "RP-49 ritmo: primera", 8],
    [2, "RP-49 ritmo: segunda", 8],
    [3, "RP-49 ritmo: tercera", 8],
  ] as const) {
    await sql`
      insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position)
      values (${owner.user_id}, ${rhythmGoalId}, ${name}, ${estimate}, true, ${position})`;
  }

  // Parents whose children are only partly estimated: one carried, one of this month.
  partialGoalId = (await goal("RP-49 fixture: parcial", "minutos")).goalId;
  for (const [name, month] of [
    ["RP-49 parcial: arrastrada", lastMonth],
    ["RP-49 parcial: del mes", `${monthFrom(today, 0)}-01`],
  ] as const) {
    const [parent] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${owner.user_id}, ${partialGoalId}, ${name}, ${month}) returning id`;
    await sql`
      insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
      values (${owner.user_id}, ${partialGoalId}, ${`${name} con monto`}, ${parent.id}, 5),
             (${owner.user_id}, ${partialGoalId}, ${`${name} sin monto`}, ${parent.id}, null)`;
  }

  // Minutes, fed by a source that counts searches: the units differ (RP-14).
  mismatchGoalId = (await goal("RP-49 fixture: unidad distinta", "minutos")).goalId;
  const mismatch = await plan.addCommitment({
    goalId: mismatchGoalId,
    name: "RP-49 fixture: evidencia en otra unidad",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!mismatch.ok) throw new Error(`addCommitment(mismatch): ${mismatch.error}`);

  const archivedResult = await plan.archiveGoal({ goalId: archivedGoalId });
  if (!archivedResult.ok) throw new Error(`archiveGoal: ${archivedResult.error}`);

  const [member] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no member identity — run harness:token for this lane");
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-49 ajena', ${horizon}) returning id`;
  foreignGoalId = foreign.id;
});

after(async () => {
  const ids = [...goalIds, foreignGoalId].filter(Boolean);
  if (ids.length > 0) await sql`delete from goals.goals where id in ${sql(ids)}`;
  await sql.end();
});

test("loadReport: two open goals report; the archived and the other person's do not", async () => {
  evidenceRejects = false;
  const report = await loadReport(today);
  assert.equal(report.today, today);
  assert.equal(report.evidence, "read");
  // Sibling files of `check:plan` run at once on this identity: only this
  // file's own fixtures are counted.
  const own = [minutesGoalId, searchesGoalId, archivedGoalId, foreignGoalId];
  assert.deepEqual(
    report.goals.map((goal) => goal.id).filter((id) => own.includes(id)).sort(),
    [minutesGoalId, searchesGoalId].sort(),
  );
  assert.ok(!report.goals.some((goal) => goal.id === archivedGoalId));
  assert.ok(!report.goals.some((goal) => goal.id === foreignGoalId));
});

test("loadReport: a goal's month and to-date figures are what loadGoal reads", async () => {
  evidenceRejects = false;
  const { toDate } = await import("@/lib/plan/months");
  const report = await loadReport(today);
  for (const id of [minutesGoalId, searchesGoalId]) {
    const entry = report.goals.find((goal) => goal.id === id);
    const loaded = await loadGoal(id, today);
    assert.ok(entry && loaded);
    assert.equal(entry.name, loaded.name);
    assert.equal(entry.unit, loaded.measureUnit);
    assert.deepEqual(entry.toDate, toDate(loaded.months));
    assert.deepEqual(
      entry.months.map((row) => ({ ...row, tasks: undefined, taskCount: undefined, carried: null })),
      loaded.months.map((row) => ({ ...row, tasks: undefined, taskCount: undefined, carried: null })),
    );
    assert.deepEqual(entry.weeks, loaded.weeks);
  }
});

// Figures written down from the fixtures, not read back through `loadGoal`:
// the minutes goal holds a 30-minute tap and a done 25-minute task against a
// plan of 720; the searches goal holds the stubbed 5 + 3 + 2 lookups and no
// plan this month. `loadReport` takes the day as an argument, so the pace
// rule (RP-29, from the 20th) is driven on days the test picks, not the day
// the suite happens to run.
test("loadReport: this month's figures, and under 60 % is flagged from the 20th and not before", async () => {
  evidenceRejects = false;
  const month = today.slice(0, 7);
  const onTwentieth = await loadReport(`${month}-20`);
  const minutes = onTwentieth.goals.find((goal) => goal.id === minutesGoalId)!;
  assert.deepEqual(minutes.thisMonth, { planned: 720, reached: 55, underPace: true });
  const searches = onTwentieth.goals.find((goal) => goal.id === searchesGoalId)!;
  assert.deepEqual(searches.thisMonth, { planned: null, reached: 10, underPace: false });

  const onNineteenth = await loadReport(`${month}-19`);
  const early = onNineteenth.goals.find((goal) => goal.id === minutesGoalId)!;
  assert.deepEqual(early.thisMonth, { planned: 720, reached: 55, underPace: false });
});

test("loadReport: phases and the carried task read as the goal holds them", async () => {
  const report = await loadReport(today);
  const minutes = report.goals.find((goal) => goal.id === minutesGoalId)!;
  assert.deepEqual(
    minutes.phases.map(({ aim, current }) => ({ aim, current })),
    [{ aim: "RP-49 fixture: fase del plan", current: true }],
  );
  assert.deepEqual(minutes.carried, [
    {
      name: "RP-49 fixture: arrastrada",
      note: null,
      from: `${monthFrom(today, -1)}-01`,
      owes: 40,
      hasAmount: true,
      children: [{ name: "RP-49 fixture: hija", note: null, owes: 40, hasAmount: true }],
    },
  ]);
});

test("loadReport: four application statements, two transactions that overlap", async () => {
  realReader = true;
  await loadReport(today);
  const before = wireCalls.length;
  let overlapped: true;
  try {
    overlapped = await proveOverlap(() => loadReport(today), { deadlineMs: 10_000 });
  } finally {
    realReader = false;
  }
  const wire = readWire(wireCalls.slice(before));
  console.log(`wire: ${JSON.stringify(wire)}`);
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
  assert.equal(overlapped, true);
});

test("loadReport: evidence that cannot be read says so and both goals keep their declared half", async () => {
  evidenceRejects = true;
  try {
    const report = await loadReport(today);
    assert.equal(report.evidence, "unreadable");
    const own = [minutesGoalId, searchesGoalId, archivedGoalId, foreignGoalId];
    assert.deepEqual(
      report.goals.map((goal) => goal.id).filter((id) => own.includes(id)).sort(),
      [minutesGoalId, searchesGoalId].sort(),
    );
    const minutes = report.goals.find((goal) => goal.id === minutesGoalId)!;
    assert.equal(minutes.thisMonth.reached, 55);
    const searches = report.goals.find((goal) => goal.id === searchesGoalId)!;
    assert.equal(searches.thisMonth.reached, 0);
  } finally {
    evidenceRejects = false;
  }
});

test("loadReport: a carried parent lists only what is undone, owing its estimate; no estimate reads hasAmount false", async () => {
  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === sharesGoalId)!;
  const from = `${monthFrom(today, -1)}-01`;
  assert.deepEqual(entry.carried, [
    { name: "RP-49 cuota: debe", note: null, from, owes: 40, hasAmount: true, children: [] },
    {
      name: "RP-49 cuota: mitad",
      note: null,
      from,
      owes: 15,
      hasAmount: true,
      children: [{ name: "RP-49 cuota: mitad pendiente", note: null, owes: 15, hasAmount: true }],
    },
    { name: "RP-49 cuota: sin monto", note: null, from, owes: 0, hasAmount: false, children: [] },
  ]);
  // «toda hecha» finished its children before this month: it is not listed at all.
  assert.ok(!entry.carried.some((item) => item.name === "RP-49 cuota: toda hecha"));
});

test("loadReport: a closed month reads its share carried; the current and future months read null", async () => {
  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === sharesGoalId)!;
  const byMonth = new Map(entry.months.map((row) => [row.month.slice(0, 7), row]));
  // 60 + 40 + 10 + 15 + 20 planned; 40 + 15 still carried.
  assert.equal(byMonth.get(monthFrom(today, -1))!.carried, Math.floor((55 * 100) / 145));
  assert.equal(byMonth.get(monthFrom(today, -2))!.carried, null);
  assert.equal(byMonth.get(today.slice(0, 7))!.carried, null);
  assert.equal(byMonth.get(monthFrom(today, 1))!.carried, null);
});

test("loadReport: a goal with a rhythm lists this month's placed tasks, the plan's order, none carried", async () => {
  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === rhythmGoalId)!;
  // 20 a month holds the first two (8 + 8) whole and 4 of the third.
  assert.deepEqual(
    entry.tasks.map((item) => ({ name: item.name, from: item.from, done: item.done })),
    [
      { name: "RP-49 ritmo: primera", from: null, done: false },
      { name: "RP-49 ritmo: segunda", from: null, done: false },
      { name: "RP-49 ritmo: tercera", from: null, done: false },
    ],
  );
  assert.deepEqual(entry.carried, []);
});

test("loadReport: this month's list of a goal with fixed months keeps carried first, then its own, done and not", async () => {
  const report = await loadReport(today);
  const minutes = report.goals.find((goal) => goal.id === minutesGoalId)!;
  assert.deepEqual(
    minutes.tasks.map((item) => ({ name: item.name, from: item.from, done: item.done })),
    [
      { name: "RP-49 fixture: arrastrada", from: `${monthFrom(today, -1)}-01`, done: false },
      { name: "RP-49 fixture: hecha", from: null, done: true },
    ],
  );
});

test("loadReport: a parent with any estimated child has an amount, carried or of the month", async () => {
  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === partialGoalId)!;
  assert.deepEqual(
    entry.tasks.map((item) => [item.name, item.hasAmount]),
    [
      ["RP-49 parcial: arrastrada", true],
      ["RP-49 parcial: del mes", true],
    ],
  );
  assert.deepEqual(entry.carried.map((item) => [item.name, item.hasAmount]), [["RP-49 parcial: arrastrada", true]]);
});

test("loadReport: measureFed is true only for a goal whose evidence commitment is in its own unit (RP-14)", async () => {
  for (const evidence of [false, true]) {
    evidenceRejects = !evidence;
    const report = await loadReport(today);
    const fed = (id: string) => report.goals.find((goal) => goal.id === id)!.measureFed;
    assert.equal(fed(searchesGoalId), true);
    assert.equal(fed(minutesGoalId), false);
    assert.equal(fed(mismatchGoalId), false);
  }
  evidenceRejects = false;
});

test("loadReport: a task cut at the month's edge reads its part here and the month it goes on in; a whole one reads none", async () => {
  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === rhythmGoalId)!;
  const byName = new Map(entry.tasks.map((item) => [item.name, item]));
  const third = byName.get("RP-49 ritmo: tercera")!;
  assert.equal(third.estimate, 8);
  assert.equal(third.part, 4);
  assert.equal(third.continuesIn, `${monthFrom(today, 1)}-01`);
  const first = byName.get("RP-49 ritmo: primera")!;
  assert.deepEqual([first.part, first.continuesIn], [null, null]);
});

async function ownerId(): Promise<string> {
  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${minutesGoalId}`;
  return owner.user_id;
}

async function seedGoal(name: string, fields: { horizon: string; createdAt?: string; unit?: string }): Promise<string> {
  const user = await ownerId();
  const [row] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, measure_unit, measure_name)
    values (${user}, ${name}, ${fields.horizon}, ${fields.createdAt ?? new Date().toISOString()}, ${fields.unit ?? null}, ${fields.unit ? "Tiempo" : null})
    returning id`;
  goalIds.push(row.id);
  return row.id;
}

test("loadReport: a goal whose horizon is today has ended the day before; one ending tomorrow has not (RP-49)", async () => {
  const { dayBefore } = await import("@/lib/day/weeks");
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDay = tomorrow.toISOString().slice(0, 10);
  const endsToday = await seedGoal("RP-49 fixture: horizonte hoy", { horizon: today });
  const endsTomorrow = await seedGoal("RP-49 fixture: horizonte mañana", { horizon: tomorrowDay });

  const report = await loadReport(today);
  const byId = (id: string) => report.goals.find((goal) => goal.id === id)!;
  assert.equal(byId(endsToday).endedOn, dayBefore(today));
  assert.equal(byId(endsTomorrow).endedOn, null);
});

test("loadReport: the second part of a week cut by a month ends the week's last day and totals what that span holds (RP-17, RP-49)", async () => {
  // Weeks run Monday to Sunday: week 2 of a goal opened on Saturday 2026-03-28 is 03-30 to 04-05, cut on 04-01.
  const goalId = await seedGoal("RP-17 fixture: semana partida", {
    horizon: "2026-06-01",
    createdAt: "2026-03-28T12:00:00Z",
    unit: "minutos",
  });
  const user = await ownerId();
  for (const [name, day, estimate] of [
    ["RP-17 semana: antes del corte", "2026-03-30", 20],
    ["RP-17 semana: despues del corte", "2026-04-01", 7],
    ["RP-17 semana: ultimo dia", "2026-04-05", 30],
  ] as const) {
    const [task] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${user}, ${goalId}, ${name}, '2026-04-01', ${estimate}) returning id`;
    await sql`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${user}, ${goalId}, ${task.id}, ${day})`;
  }

  const report = await loadReport("2026-04-06");
  const entry = report.goals.find((goal) => goal.id === goalId)!;
  assert.deepEqual(
    entry.weekSplits.map(({ index, month, startsOn, endsOn, total }) => ({ index, month, startsOn, endsOn, total })),
    [
      { index: 2, month: "2026-03-01", startsOn: "2026-03-30", endsOn: "2026-03-31", total: 20 },
      { index: 2, month: "2026-04-01", startsOn: "2026-04-01", endsOn: "2026-04-05", total: 37 },
    ],
  );
});

test("loadReport: a task fixed to last month and done this month is not carried as owed (RP-49)", async () => {
  const goalId = await seedGoal("RP-49 fixture: arrastrada hecha", {
    horizon: `${monthFrom(today, 2)}-01`,
    createdAt: new Date(Date.now() - 70 * 86_400_000).toISOString(),
    unit: "minutos",
  });
  const user = await ownerId();
  const lastMonth = `${monthFrom(today, -1)}-01`;
  const [finished] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${user}, ${goalId}, 'RP-49 arrastrada: hecha', ${lastMonth}, 10) returning id`;
  await sql`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${user}, ${goalId}, ${finished.id}, ${today})`;
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${user}, ${goalId}, 'RP-49 arrastrada: pendiente', ${lastMonth}, 10)`;

  const report = await loadReport(today);
  const entry = report.goals.find((goal) => goal.id === goalId)!;
  assert.deepEqual(entry.carried.map((item) => item.name), ["RP-49 arrastrada: pendiente"]);
});

test("loadReport: the week's planned figure takes the goal's rhythm where the month has no amount (RP-58)", async () => {
  // 2026-04-06 is a Monday: the first week is seven days of a 30-day month.
  const opened = "2026-04-06T12:00:00Z";
  const withRhythm = await seedGoal("RP-58 fixture: ritmo", { horizon: "2026-07-01", createdAt: opened, unit: "minutos" });
  const withAmount = await seedGoal("RP-58 fixture: monto", { horizon: "2026-07-01", createdAt: opened, unit: "minutos" });
  const bare = await seedGoal("RP-58 fixture: sin ritmo", { horizon: "2026-07-01", createdAt: opened, unit: "minutos" });
  // Horizon 04-09 ended on Wednesday 04-08, inside the week asked about on Saturday 04-11.
  const ended = await seedGoal("RP-58 fixture: terminada", { horizon: "2026-04-09", createdAt: opened, unit: "minutos" });
  const user = await ownerId();
  await sql`update goals.goals set rhythm = 720 where id in (${withRhythm}, ${withAmount}, ${ended})`;
  await sql`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${user}, ${withAmount}, '2026-04-01', 600)`;

  const report = await loadReport("2026-04-11");
  const planned = (id: string) => report.goals.find((goal) => goal.id === id)!.weekPlanned;
  assert.equal(planned(withRhythm), Math.floor((7 * 720) / 30));
  assert.equal(planned(withAmount), Math.floor((7 * 600) / 30));
  assert.equal(planned(bare), null);
  assert.equal(planned(ended), null);
});

test("loadReport: a goal opened and closed mid-month plans its share of the rhythm in both, the week its share of the whole month (RP-74, RP-58)", async () => {
  // «Reto de lectura»: 16 September to 7 October 2026 at 600 min a month.
  const goalId = await seedGoal("RP-74 fixture: reto", {
    horizon: "2026-10-08",
    createdAt: "2026-09-16T12:00:00Z",
    unit: "minutos",
  });
  await sql`update goals.goals set rhythm = 600 where id = ${goalId}`;

  const report = await loadReport("2026-10-07");
  const entry = report.goals.find((goal) => goal.id === goalId)!;
  assert.deepEqual(entry.months.map((row) => [row.month, row.planned]), [
    ["2026-09-01", 300],
    ["2026-10-01", 135],
  ]);
  assert.equal(entry.thisMonth.planned, 135);
  assert.equal(entry.toDate.planned, 435);
  // 5 to 7 October: three days of 600 over 31.
  assert.equal(entry.weekPlanned, 58);
});
