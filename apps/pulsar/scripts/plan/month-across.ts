// Drives `loadMonthAcross` (`lib/queries/month.ts`, RP-43) the way `report.ts`
// drives `loadReport`: statements counted off the driver's own wire, the
// session `harness:mint-session` left standing, the three Next-only modules
// stubbed before the first `@/` import. Goals are written through the actions;
// the pooler plants only what no action writes and deletes each fixture by its
// exact id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { normalized, proveOverlap, readWire, wrapPostgres, type DebugCall, type PostgresFactory } from "./wire";

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
let monthStart: string;
let aId: string;
let bId: string;
let cId: string;
let archivedId: string;
let endedId: string;
let dId: string;
let fId: string;
let gId: string;
let loadMonthAcross: typeof import("@/lib/queries/month").loadMonthAcross;
let archiveGoal: typeof import("@/app/actions/plan").archiveGoal;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  archiveGoal = plan.archiveGoal;
  const { setMonthBudget } = await import("@/app/actions/budgets");
  const { declareFact } = await import("@/app/actions/facts");
  ({ loadMonthAcross } = await import("@/lib/queries/month"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  monthStart = `${today.slice(0, 7)}-01`;
  const horizon = `${monthFrom(today, 2)}-01`;

  async function goal(name: string, unit: string | null): Promise<{ goalId: string; commitmentId: string | null }> {
    const created = await plan.createGoal({ name, horizon });
    if (!created.ok) throw new Error(`createGoal: ${created.error}`);
    goalIds.push(created.goalId);
    if (unit === null) return { goalId: created.goalId, commitmentId: null };
    const commitment = await plan.addCommitment({
      goalId: created.goalId,
      name: "RP-43 fixture: cantidad",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit,
    });
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    return { goalId: created.goalId, commitmentId: commitment.commitmentId };
  }

  const a = await goal("RP-43 fixture: A", "minutos");
  aId = a.goalId;
  const b = await goal("RP-43 fixture: B", "minutos");
  bId = b.goalId;
  cId = (await goal("RP-43 fixture: C", null)).goalId;
  archivedId = (await goal("RP-43 fixture: archivada", "minutos")).goalId;
  endedId = (await goal("RP-43 fixture: terminada", "minutos")).goalId;
  // D measures in the reading source's own unit, so its evidence feeds `reached`.
  const d = await goal("RP-43 fixture: D", "searches");
  dId = d.goalId;
  const source = await plan.addCommitment({
    goalId: dId,
    name: "RP-43 fixture: evidencia",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!source.ok) throw new Error(`addCommitment: ${source.error}`);
  // A's second commitment holds the month's first-day fact, so no date collides
  // with the one `declareFact` writes today.
  const second = await plan.addCommitment({
    goalId: aId,
    name: "RP-43 fixture: segunda cantidad",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 10,
    unit: "minutos",
  });
  if (!second.ok) throw new Error(`addCommitment: ${second.error}`);

  const budget = await setMonthBudget({ goalId: aId, month: today.slice(0, 7), amount: 600 });
  if (!budget.ok) throw new Error(`setMonthBudget: ${budget.error}`);
  const fact = await declareFact({ commitmentId: a.commitmentId!, quantity: 30 });
  if (!fact.ok) throw new Error(`declareFact: ${fact.error}`);

  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from goals.goals where id = ${aId}`;
  const lastMonth = monthFrom(today, -1);
  await sql`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.user_id}, ${aId}, ${second.commitmentId}, ${monthStart}, 30)`;
  await sql`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.user_id}, ${dId}, ${d.commitmentId}, ${monthStart}, 7)`;
  await sql`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${owner.user_id}, ${aId}, ${a.commitmentId}, ${`${lastMonth}-15`}, 45)`;
  const [done] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${owner.user_id}, ${aId}, 'RP-43 fixture: hecha', ${monthStart}, 60) returning id`;
  await sql`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${owner.user_id}, ${aId}, ${done.id}, ${today})`;
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${owner.user_id}, ${cId}, 'RP-43 fixture: arrastrada', ${`${lastMonth}-01`})`;

  // F plans at 10 a month: its 15-unit task splits, its 4-unit task waits for next month.
  const f = await goal("RP-50 fixture: F", "minutos");
  fId = f.goalId;
  const rhythm = await (await import("@/app/actions/roadmap")).setRhythm({ goalId: fId, amount: 10 });
  if (!rhythm.ok) throw new Error(`setRhythm: ${rhythm.error}`);
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan)
    values (${owner.user_id}, ${fId}, 'RP-50 fixture: partida', 15, true),
           (${owner.user_id}, ${fId}, 'RP-50 fixture: pequeña', 4, true)`;

  // G holds a parent fixed to this month whose children are only partly estimated.
  gId = (await goal("RP-50 fixture: G", "minutos")).goalId;
  const [mixed] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${owner.user_id}, ${gId}, 'RP-50 fixture: mixta', ${monthStart}) returning id`;
  await sql`
    insert into goals.one_offs (user_id, goal_id, name, parent_id, estimate)
    values (${owner.user_id}, ${gId}, 'RP-50 fixture: mixta con monto', ${mixed.id}, 3),
           (${owner.user_id}, ${gId}, 'RP-50 fixture: mixta sin monto', ${mixed.id}, null)`;

  const archived = await archiveGoal({ goalId: archivedId });
  if (!archived.ok) throw new Error(`archiveGoal: ${archived.error}`);
  await sql`
    update goals.goals set created_at = now() - interval '5 days', horizon = ${today}
    where id = ${endedId} and user_id = ${owner.user_id}`;
});

after(async () => {
  const ids = goalIds.filter(Boolean);
  if (ids.length > 0) await sql`delete from goals.goals where id in ${sql(ids)}`;
  await sql.end();
});

const own = () => [aId, bId, cId, dId, archivedId, endedId];

const nextMonthOf = (monthFirst: string) => `${monthFrom(monthFirst, 1)}-01`;

test("loadMonthAcross: A, B, C and D read; the archived and the ended goal do not", async () => {
  const month = await loadMonthAcross(today);
  assert.equal(month.month, monthStart);
  assert.equal(month.evidence, "read");
  assert.deepEqual(
    month.goals.map((goal) => goal.id).filter((id) => own().includes(id)),
    [aId, bId, cId, dId],
  );
});

test("loadMonthAcross: A plans 600 and reached 120; B plans nothing; C has no line", async () => {
  const month = await loadMonthAcross(today);
  const a = month.goals.find((goal) => goal.id === aId)!;
  assert.deepEqual(a.line, {
    planned: 600,
    reached: 120,
    underPace: Number(today.slice(8, 10)) >= 20,
  });
  assert.equal(a.unit, "minutos");
  const b = month.goals.find((goal) => goal.id === bId)!;
  assert.equal(b.line?.planned, null);
  assert.equal(b.line?.reached, 0);
  const c = month.goals.find((goal) => goal.id === cId)!;
  assert.equal(c.line, null);
  assert.equal(c.unit, null);
});

test("loadMonthAcross: C lists its carried task first, from last month; A's done task is done", async () => {
  const month = await loadMonthAcross(today);
  const c = month.goals.find((goal) => goal.id === cId)!;
  assert.equal(c.items[0].task.name, "RP-43 fixture: arrastrada");
  assert.equal(c.items[0].carriedFrom, `${monthFrom(today, -1)}-01`);
  assert.equal(c.items[0].done, false);
  const a = month.goals.find((goal) => goal.id === aId)!;
  assert.deepEqual(
    a.items.map((item) => [item.task.name, item.done, item.task.factId !== null]),
    [["RP-43 fixture: hecha", true, true]],
  );
});

test("loadMonthAcross: D reaches its 7 declared plus 10 of evidence when the reader reads", async () => {
  const month = await loadMonthAcross(today);
  assert.equal(month.goals.find((goal) => goal.id === dId)!.line?.reached, 7 + 5 + 3 + 2);
});

test("loadMonthAcross: evidence that cannot be read says so; A keeps 120 and D its declared 7", async () => {
  evidenceRejects = true;
  try {
    const month = await loadMonthAcross(today);
    assert.equal(month.evidence, "unreadable");
    assert.equal(month.goals.find((goal) => goal.id === aId)!.line?.reached, 120);
    assert.equal(month.goals.find((goal) => goal.id === dId)!.line?.reached, 7);
  } finally {
    evidenceRejects = false;
  }
});

async function wireOfOneRead() {
  realReader = true;
  await loadMonthAcross(today);
  const before = wireCalls.length;
  let overlapped: true;
  try {
    overlapped = await proveOverlap(() => loadMonthAcross(today), { deadlineMs: 10_000 });
  } finally {
    realReader = false;
  }
  return { calls: wireCalls.slice(before), overlapped };
}

test("loadMonthAcross: four application statements in two overlapping transactions, four goals", async () => {
  const { calls, overlapped } = await wireOfOneRead();
  const wire = readWire(calls);
  console.log(`wire (4 goals): ${JSON.stringify(wire)}`);
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
  assert.equal(overlapped, true);
});

test("loadMonthAcross: the reading statement bounds its days on both ends", async () => {
  const { calls } = await wireOfOneRead();
  const reading = calls.filter((call) => normalized(call.query).includes('"lookups"'));
  assert.equal(reading.length, 1);
  const bounds = /::date between \$(\d+) and \$(\d+)/.exec(normalized(reading[0].query));
  assert.ok(bounds, "the civil day sits between two parameters");
  assert.equal(reading[0].parameters[Number(bounds[1]) - 1], monthStart, "the month's first day opens it");
  assert.equal(reading[0].parameters[Number(bounds[2]) - 1], today, "today closes it");
});

test("loadMonthAcross: the same four statements with one goal", async () => {
  for (const id of [bId, cId, dId]) {
    const archived = await archiveGoal({ goalId: id });
    if (!archived.ok) throw new Error(`archiveGoal: ${archived.error}`);
  }
  const month = await loadMonthAcross(today);
  assert.deepEqual(
    month.goals.map((goal) => goal.id).filter((id) => own().includes(id)),
    [aId],
  );
  const { calls, overlapped } = await wireOfOneRead();
  const wire = readWire(calls);
  console.log(`wire (1 goal): ${JSON.stringify(wire)}`);
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
  assert.equal(overlapped, true);
});

test("loadMonthAcross: a split task lists with its part, and the line carries the rhythm", async () => {
  const month = await loadMonthAcross(today);
  const f = month.goals.find((goal) => goal.id === fId)!;
  // F opened today: its month plans the share of 10 its days from today take (RP-74).
  const length = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  assert.equal(f.line?.planned, Math.floor((10 * (length - Number(today.slice(8, 10)) + 1)) / length));
  assert.deepEqual(
    f.items.map((item) => [item.task.name, item.part, item.hours, item.from, item.to, item.fixed]),
    [["RP-50 fixture: partida", 10, 15, null, nextMonthOf(monthStart), false]],
  );
  assert.equal(f.items[0].owes, 10);
  assert.equal(f.items[0].hasAmount, true);
});

test("loadMonthAcross: a fixed parent reads fixed, and an amount on any child is an amount", async () => {
  const g = (await loadMonthAcross(today)).goals.find((goal) => goal.id === gId)!;
  const item = g.items.find((entry) => entry.task.name === "RP-50 fixture: mixta")!;
  assert.equal(item.fixed, true);
  assert.equal(item.hasAmount, true);
});

test("loadMonthAcross: the plan's reading still takes two transactions and four statements", async () => {
  const { calls } = await wireOfOneRead();
  const wire = readWire(calls);
  assert.equal(wire.connections, 2);
  assert.equal(wire.applicationStatements, 4);
});

test("loadMonthAcross: a budget of a later month moves where the split task goes on", async () => {
  const { setMonthBudget } = await import("@/app/actions/budgets");
  const closed = await setMonthBudget({ goalId: fId, month: monthFrom(today, 1), amount: 0 });
  if (!closed.ok) throw new Error(`setMonthBudget: ${closed.error}`);
  const f = (await loadMonthAcross(today)).goals.find((goal) => goal.id === fId)!;
  assert.equal(f.items[0].part, 10);
  assert.equal(f.items[0].to, `${monthFrom(today, 2)}-01`);
});
