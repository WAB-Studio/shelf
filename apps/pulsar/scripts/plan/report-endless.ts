// `loadReport` (`lib/queries/report.ts`, RP-106) hands over every month of a goal with no end,
// closed ones included, each marked `endless`; a goal with an end reads as it did, and the
// report stays at four statements.
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
let realReader = false;

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
      return { readReadingLookups: async (...args: unknown[]) => (realReader ? real.readReadingLookups(...args) : []) };
    }
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as PostgresFactory;
      return wrapPostgres(real, (call) => wireCalls.push(call));
    }
    return originalLoad(request, parent, isMain);
  };
}

function monthIndex(day: string): number {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

function monthAt(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

const goalIds: string[] = [];
let today: string;
let openedOn: string;
let endlessId: string;
let endedId: string;
let loadReport: typeof import("@/lib/queries/report").loadReport;

before(async () => {
  installStubs(loadCookies());
  const plan = await import("@/app/actions/plan");
  ({ loadReport } = await import("@/lib/queries/report"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  const horizon = monthAt(monthIndex(today) + 2);

  const endless = await plan.createGoal({ name: "RP-106 fixture: sin final", horizon: null });
  if (!endless.ok) throw new Error(`createGoal: ${endless.error}`);
  endlessId = endless.goalId;
  const ended = await plan.createGoal({ name: "RP-106 fixture: con final", horizon });
  if (!ended.ok) throw new Error(`createGoal: ${ended.error}`);
  endedId = ended.goalId;
  goalIds.push(endlessId, endedId);
  const [row] = await sql<{ opened: string }[]>`
    update goals.goals set created_at = now() - interval '80 days' where id in ${sql(goalIds)}
    returning to_char((created_at at time zone 'America/Bogota')::date, 'YYYY-MM-DD') as opened`;
  openedOn = row.opened;
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("a goal with no end keeps its closed months, twelve open ones, all marked", async () => {
  const report = await loadReport(today);
  const goal = report.goals.find((entry) => entry.id === endlessId);
  assert.ok(goal);
  const past = monthIndex(today) - monthIndex(openedOn);
  assert.ok(past >= 2 && past <= 3, "80 days reach back two or three closed months");
  assert.deepEqual(
    goal.months.map((m) => m.month),
    Array.from({ length: past + 12 }, (_, i) => monthAt(monthIndex(openedOn) + i)),
  );
  assert.equal(goal.months.filter((m) => m.past).length, past);
  assert.equal(goal.months.filter((m) => m.current).length, 1);
  assert.ok(goal.months.every((m) => "endless" in m && m.endless === true));
});

test("a goal with an end reads as it did: opening to its last month, none marked", async () => {
  const report = await loadReport(today);
  const goal = report.goals.find((entry) => entry.id === endedId);
  assert.ok(goal);
  assert.deepEqual(
    goal.months.map((m) => m.month),
    Array.from({ length: monthIndex(today) + 2 - monthIndex(openedOn) }, (_, i) => monthAt(monthIndex(openedOn) + i)),
  );
  assert.ok(goal.months.every((m) => !("endless" in m)));
});

test("loadReport stays at four application statements", async () => {
  realReader = true;
  try {
    await loadReport(today);
    const before = wireCalls.length;
    await loadReport(today);
    assert.equal(readWire(wireCalls.slice(before)).applicationStatements, 4);
  } finally {
    realReader = false;
  }
});
