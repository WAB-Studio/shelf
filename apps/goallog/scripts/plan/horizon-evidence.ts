// The horizon is the first day AFTER a goal (RP-11): evidence recorded on it
// belongs to no day of the goal, so neither the goal's total (`loadGoal`,
// RP-14) nor the export (`loadReport`, RP-49) may count it. The opening day
// and the last day (`horizon - 1`) do count.
//
// The reader is replaced by one that behaves like the real one: it resolves
// the bounds it is handed (a SQL fragment for `loadGoal`, a day for
// `loadReport`) inside the reading transaction and returns the planted rows
// whose day lies between them, inclusive. The expected numbers are written
// down from the plant, never read back through the code under test.
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

type Planted = { day: string; quantity: number };

// Flipped per test.
let planted: Planted[] = [];
let readerRejects = false;

type ReaderTx = { execute: (query: SQL) => Promise<Array<{ f: string; t: string }>> };

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
          if (readerRejects) throw new Error("horizon-evidence.ts: simulated reading-lookups failure");
          const [bounds] = await args.tx.execute(dsql`select (${args.from})::date as f, (${args.to})::date as t`);
          return planted
            .filter((row) => row.day >= String(bounds.f) && row.day <= String(bounds.t))
            .map((row) => ({
              day: row.day,
              quantity: row.quantity,
              unit: "searches",
              labelKey: "sources.readingLookups",
            }));
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const DECLARED = 7;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let goalId: string;
let openedOn: string;
let horizon: string;
let lastDay: string;
let afterGoal: string;
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;
let loadReport: typeof import("@/lib/queries/report").loadReport;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  const { declareFact } = await import("@/app/actions/facts");
  ({ loadGoal } = await import("@/lib/queries/goal"));
  ({ loadReport } = await import("@/lib/queries/report"));
  const { todayInZone } = await import("@/lib/zone");
  const today = todayInZone();

  // Mid-month, so `horizon - 1` sits in the horizon's own month and the
  // report's month rows hold both days.
  horizon = `${monthFrom(today, 2)}-15`;
  lastDay = addDays(horizon, -1);
  afterGoal = addDays(horizon, 1);

  const created = await plan.createGoal({ name: "horizon-evidence.ts probe", horizon });
  if (!created.ok) throw new Error(`createGoal: ${created.error}`);
  goalId = created.goalId;
  const counter = await plan.addCommitment({
    goalId,
    name: "horizon-evidence.ts probe: contador",
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 1,
    unit: "searches",
  });
  if (!counter.ok) throw new Error(`addCommitment(counter): ${counter.error}`);
  const evidence = await plan.addCommitment({
    goalId,
    name: "horizon-evidence.ts probe: lectura",
    cadenceKind: "daily",
    satisfaction: "evidence",
    sourceKey: "reading_lookups",
    threshold: 1,
  });
  if (!evidence.ok) throw new Error(`addCommitment(evidence): ${evidence.error}`);
  const fact = await declareFact({ commitmentId: counter.commitmentId, quantity: DECLARED });
  if (!fact.ok) throw new Error(`declareFact: ${fact.error}`);

  await sql`update goals.goals set created_at = now() - interval '20 days' where id = ${goalId}`;
  const [row] = await sql<{ day: string }[]>`
    select (created_at at time zone 'America/Bogota')::date::text as day from goals.goals where id = ${goalId}`;
  openedOn = row.day;
});

after(async () => {
  if (goalId) await sql`delete from goals.goals where id = ${goalId}`;
  await sql.end();
});

// The evidence half of the report's figures for the probe goal: its month
// rows summed, less the declared tap.
async function reportEvidence(): Promise<number> {
  const report = await loadReport(afterGoal);
  const entry = report.goals.find((goal) => goal.id === goalId);
  assert.ok(entry, "the probe goal is in the report");
  return entry.months.reduce((sum, row) => sum + row.reached, 0) - DECLARED;
}

async function goalEvidence(): Promise<number> {
  const view = await loadGoal(goalId, afterGoal);
  assert.ok(view, "the probe goal loads");
  return view.measureTotal - DECLARED;
}

test("loadGoal: evidence on the horizon day is not in the goal's total", async () => {
  readerRejects = false;
  planted = [
    { day: lastDay, quantity: 1 },
    { day: horizon, quantity: 1 },
  ];
  assert.equal(await goalEvidence(), 1);
});

test("loadReport: evidence on the horizon day is not in the goal's figures", async () => {
  readerRejects = false;
  planted = [
    { day: lastDay, quantity: 1 },
    { day: horizon, quantity: 1 },
  ];
  assert.equal(await reportEvidence(), 1);
});

test("the day the goal opened counts, in the total and in the report", async () => {
  readerRejects = false;
  planted = [{ day: openedOn, quantity: 1 }];
  assert.equal(await goalEvidence(), 1);
  assert.equal(await reportEvidence(), 1);
});

test("the last day of the goal (horizon - 1) counts, in the total and in the report", async () => {
  readerRejects = false;
  planted = [{ day: lastDay, quantity: 1 }];
  assert.equal(await goalEvidence(), 1);
  assert.equal(await reportEvidence(), 1);
});

test("the day before the goal opened does not count", async () => {
  readerRejects = false;
  planted = [{ day: addDays(openedOn, -1), quantity: 1 }];
  assert.equal(await goalEvidence(), 0);
  assert.equal(await reportEvidence(), 0);
});

test("an unreadable source leaves the declared half alone (RNP-04)", async () => {
  readerRejects = true;
  planted = [{ day: lastDay, quantity: 1 }];
  try {
    const view = await loadGoal(goalId, afterGoal);
    assert.ok(view);
    assert.equal(view.measureTotal, DECLARED);
    const report = await loadReport(afterGoal);
    assert.equal(report.evidence, "unreadable");
    const entry = report.goals.find((goal) => goal.id === goalId);
    assert.ok(entry);
    assert.equal(entry.months.reduce((sum, row) => sum + row.reached, 0), DECLARED);
  } finally {
    readerRejects = false;
  }
});
