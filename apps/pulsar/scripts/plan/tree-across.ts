// Drives `loadMonthAcross` and `loadReport` over a tree of goals (RP-80, RP-84):
// the general G holds g1 (large), which holds p (small); q ended under G; S
// stands alone. Statements are counted off the driver's own wire. Goals are
// written through the actions; the pooler plants only what no action writes
// (the tree's edges, facts, an ended goal) and deletes each fixture by its exact id.
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
const evidenceRejects = false;
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
let monthStart: string;
let gId: string;
let sId: string;
let g1Id: string;
let pId: string;
let qId: string;
let loadMonthAcross: typeof import("@/lib/queries/month").loadMonthAcross;
let loadReport: typeof import("@/lib/queries/report").loadReport;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  const { setMonthBudget } = await import("@/app/actions/budgets");
  ({ loadMonthAcross } = await import("@/lib/queries/month"));
  ({ loadReport } = await import("@/lib/queries/report"));
  const { todayInZone } = await import("@/lib/zone");
  // The loaders read a fixed mid-month day: nothing below depends on the day of the month the run falls on.
  const realToday = todayInZone();
  today = `${realToday.slice(0, 7)}-15`;
  console.log(`clock: ${realToday}, loaders read ${today}`);
  monthStart = `${today.slice(0, 7)}-01`;

  async function goal(name: string, horizonMonths: number, unit: string | null) {
    const created = await plan.createGoal({ name, horizon: `${monthFrom(today, horizonMonths)}-01` });
    if (!created.ok) throw new Error(`createGoal: ${created.error}`);
    goalIds.push(created.goalId);
    if (unit === null) return { goalId: created.goalId, commitmentId: null };
    const commitment = await plan.addCommitment({
      goalId: created.goalId,
      name: "RP-84 fixture: cantidad",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit,
    });
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    return { goalId: created.goalId, commitmentId: commitment.commitmentId };
  }

  // Created G, S, g1, p, q: by position S sits between G and its goals.
  const g = await goal("RP-84 fixture: G", 4, null);
  gId = g.goalId;
  sId = (await goal("RP-84 fixture: S", 2, "minutos")).goalId;
  const g1 = await goal("RP-84 fixture: g1", 3, "minutos");
  g1Id = g1.goalId;
  const p = await goal("RP-84 fixture: p", 2, "minutos");
  pId = p.goalId;
  const q = await goal("RP-84 fixture: q", 2, "minutos");
  qId = q.goalId;

  // g1 holds a month amount of its own before it holds goals; it stays stored and unread (RP-80).
  const stored = await setMonthBudget({ goalId: g1Id, month: today.slice(0, 7), amount: 999 });
  if (!stored.ok) throw new Error(`setMonthBudget: ${stored.error}`);
  const budget = await setMonthBudget({ goalId: pId, month: today.slice(0, 7), amount: 600 });
  if (!budget.ok) throw new Error(`setMonthBudget: ${budget.error}`);

  const [owner] = await sql<{ user_id: string }[]>`select user_id from goals.goals where id = ${gId}`;
  const lastMonth = monthFrom(today, -1);
  // g1 opened last month, before G: its 45 of then are in G's months.
  await sql`update goals.goals set created_at = ${`${lastMonth}-10T12:00:00-05:00`} where id = ${g1Id}`;
  await sql`
    update goals.goals set created_at = ${`${monthStart}T00:00:00-05:00`}
    where id in ${sql([gId, sId, pId])}`;
  // p's 30 fall on the loaders' day, in the week the holders read as current.
  await sql`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.user_id}, ${pId}, ${p.commitmentId}, ${today}, 30)`;
  // One task undone this month under g1 and under p; q's done one is below.
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${owner.user_id}, ${g1Id}, 'RP-84 fixture: tarea de g1', ${monthStart}),
           (${owner.user_id}, ${pId}, 'RP-84 fixture: tarea de p', ${monthStart})`;
  await sql`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.user_id}, ${g1Id}, ${g1.commitmentId}, ${`${lastMonth}-15`}, 45),
           (${owner.user_id}, ${g1Id}, ${g1.commitmentId}, ${monthStart}, 120)`;
  // q ended today, opened on the 1st: a task of 30 minutes done on the 1st.
  await sql`update goals.goals set created_at = ${`${monthStart}T00:00:00-05:00`}, horizon = ${today} where id = ${qId}`;
  const [done] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${owner.user_id}, ${qId}, 'RP-84 fixture: hecha', ${monthStart}, 30) returning id`;
  await sql`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${owner.user_id}, ${qId}, ${done.id}, ${monthStart})`;

  await sql`update goals.goals set parent_id = ${gId} where id in ${sql([g1Id, qId])}`;
  await sql`update goals.goals set parent_id = ${g1Id} where id = ${pId}`;
});

after(async () => {
  const ids = goalIds.filter(Boolean);
  if (ids.length > 0) {
    await sql`update goals.goals set parent_id = null where id in ${sql(ids)}`;
    await sql`delete from goals.goals where id in ${sql(ids)}`;
  }
  await sql.end();
});

const own = () => [gId, g1Id, pId, sId, qId];

async function wireOf(load: () => Promise<unknown>) {
  realReader = true;
  await load();
  const before = wireCalls.length;
  let overlapped: true;
  try {
    overlapped = await proveOverlap(load, { deadlineMs: 10_000 });
  } finally {
    realReader = false;
  }
  return { wire: readWire(wireCalls.slice(before)), overlapped };
}

test("«Mes» tree order: G, g1, p, S; q ended is not a block; one group per general", async () => {
  const month = await loadMonthAcross(today);
  assert.deepEqual(
    month.goals.map((goal) => goal.id).filter((id) => own().includes(id)),
    [gId, g1Id, pId, sId],
  );
  assert.deepEqual(
    month.groups.filter((group) => own().includes(group.rootId)),
    [
      { rootId: gId, goalIds: [gId, g1Id, pId] },
      { rootId: sId, goalIds: [sId] },
    ],
  );
});

test("«Mes» sum: g1 is its own 120 plus p's 30; G adds q's 30 on top; the stored 999 reads nothing", async () => {
  const month = await loadMonthAcross(today);
  const line = (id: string) => month.goals.find((goal) => goal.id === id)!.line;
  assert.deepEqual(line(pId), { planned: 600, reached: 30, underPace: line(pId)!.underPace });
  assert.deepEqual(line(g1Id)?.planned, 600);
  assert.equal(line(g1Id)?.reached, 150);
  assert.deepEqual(line(gId)?.planned, 600);
  assert.equal(line(gId)?.reached, 180);
  assert.equal(month.goals.find((goal) => goal.id === gId)!.unit, "minutos");
});

test("«Mes» an ended goal under an open general adds its part of the month, and draws nothing", async () => {
  const month = await loadMonthAcross(today);
  assert.equal(month.goals.some((goal) => goal.id === qId), false);
  assert.equal(month.goals.find((goal) => goal.id === gId)!.line?.reached, 150 + 30);
});

test("«Mes» a holder has no rhythm or budget of its own in its plan", async () => {
  const month = await loadMonthAcross(today);
  const g1 = month.goals.find((goal) => goal.id === g1Id)!;
  assert.deepEqual([g1.plan.rhythm, g1.plan.budgets], [null, []]);
  assert.equal(g1.holdsGoals, true);
  assert.equal(month.goals.find((goal) => goal.id === pId)!.holdsGoals, false);
});

test("«Mes» and the report name the goal above and the general at the top", async () => {
  const month = await loadMonthAcross(today);
  const p = month.goals.find((goal) => goal.id === pId)!;
  assert.deepEqual(
    [p.parentId, p.level, p.rootId, p.rootName, p.aboveName],
    [g1Id, "small", gId, "RP-84 fixture: G", "RP-84 fixture: g1"],
  );
  const report = await loadReport(today);
  const rp = report.goals.find((goal) => goal.id === pId)!;
  assert.deepEqual(
    [rp.parentId, rp.level, rp.rootId, rp.rootName, rp.aboveName],
    [g1Id, "small", gId, "RP-84 fixture: G", "RP-84 fixture: g1"],
  );
  const g = report.goals.find((goal) => goal.id === gId)!;
  assert.deepEqual([g.parentId, g.level, g.aboveName, g.rootName], [null, "general", null, "RP-84 fixture: G"]);
});

test("report tree order and groups: q after p, S last", async () => {
  const report = await loadReport(today);
  assert.deepEqual(
    report.goals.map((goal) => goal.id).filter((id) => own().includes(id)),
    [gId, g1Id, pId, qId, sId],
  );
  assert.deepEqual(
    report.groups?.filter((group) => own().includes(group.rootId)),
    [
      { rootId: gId, goalIds: [gId, g1Id, pId, qId] },
      { rootId: sId, goalIds: [sId] },
    ],
  );
});

test("report sum: G's this month, to date and months are the sums of its goals", async () => {
  const report = await loadReport(today);
  const g = report.goals.find((goal) => goal.id === gId)!;
  assert.equal(g.thisMonth.reached, 180);
  assert.equal(g.thisMonth.planned, 600);
  // g1's 45 of last month sit before G opened: G's months open where its goals do.
  assert.equal(g.toDate.reached, 180 + 45);
  const now = g.months.find((row) => row.current)!;
  assert.deepEqual([now.planned, now.reached], [600, 180]);
  const before = g.months.find((row) => row.month === `${monthFrom(today, -1)}-01`)!;
  assert.equal(before.reached, 45);
  assert.equal(g.holdsGoals, true);
  assert.equal(g.weekPlanned == null || g.weekPlanned >= 0, true);
  const g1 = report.goals.find((goal) => goal.id === g1Id)!;
  assert.equal(g1.thisMonth.reached, 150);
  assert.equal(g1.thisMonth.planned, 600);
});

test("report weeks: a goal's fact this week shows in the current week of the holders above it", async () => {
  const report = await loadReport(today);
  const current = (id: string) => report.goals.find((goal) => goal.id === id)!.weeks.find((week) => week.current)!;
  assert.equal(current(pId).total, 30);
  assert.equal(current(g1Id).total, 30);
  assert.equal(current(gId).total, 30);
});

test("report months: a holder counts the tasks of its goals plus its own", async () => {
  const report = await loadReport(today);
  const thisMonth = (id: string) => report.goals.find((goal) => goal.id === id)!.months.find((row) => row.current)!;
  assert.deepEqual(thisMonth(pId).tasks, { done: 0, total: 1 });
  assert.deepEqual(thisMonth(g1Id).tasks, { done: 0, total: 2 });
  assert.deepEqual(thisMonth(gId).tasks, { done: 1, total: 3 });
});

test("«Mes» runs in two transactions and four statements, with the tree", async () => {
  const { wire, overlapped } = await wireOf(() => loadMonthAcross(today));
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
  assert.equal(overlapped, true);
});

test("report runs in two transactions and four statements, with the tree", async () => {
  const { wire, overlapped } = await wireOf(() => loadReport(today));
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
  assert.equal(overlapped, true);
});
