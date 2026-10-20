// M14, Q2 (a): a monthless task from the stub model, driven through the whole import path into
// `confirmImport` and read back from the table. In a goal with a rhythm the task is in the plan with
// no fixed month; in a goal without one it lands in the current month, or is refused when the
// person declined the proposal. No paid call: the raw answer is a literal.
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

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = resolve(process.cwd(), `private/session-${laneNumber()}.json`);
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

const revalidated: string[] = [];

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
    if (request === "next/cache") {
      return { revalidatePath: (path: string) => void revalidated.push(path) };
    }
    return originalLoad(request, parent, isMain);
  };
}


let confirmImport: typeof import("@/app/actions/import").confirmImport;
let todayInZone: typeof import("@/lib/zone").todayInZone;
let pipeline: typeof import("@/lib/import/draft");
let checkPlan: typeof import("@/lib/import/check").check;
let placeLeftovers: typeof import("@/lib/import/coverage").placeLeftovers;
let linesToTasks: typeof import("@/lib/import/line-tasks").linesToTasks;
type RawDraft = import("@/lib/import/draft").RawDraft;
type Source = import("@/lib/import/draft").Source;

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1, connection: { statement_timeout: 15_000, lock_timeout: 10_000 } });
const goalIds: string[] = [];
const RUN = Date.now().toString(36);
let TODAY: string;

const source: Source = { kind: "lines", lines: ["# Plan", "- Leer"] };
function raw(name: string, rhythm: boolean): RawDraft {
  return {
    goals: [
      {
        key: "g1", parent: null, name, horizon: `${Number(TODAY.slice(0, 4)) + 1}-${TODAY.slice(5, 7)}-01`,
        measure: rhythm ? { name: "estudio", unit: "horas" } : null,
        rate: rhythm ? { amount: 12, unit: "hours", per: "month" } : null,
        noteSrc: [], noteText: null, src: [{ from: 1, to: 1 }], phases: [], months: [], commitments: [], rules: [],
        tasks: [{ name: "Leer", month: null as unknown as string, estimate: null, week: null, rule: null, noteSrc: [], noteText: null, src: [{ from: 2, to: 2 }], children: [] }],
      },
    ],
  };
}

function read(rawDraft: RawDraft) {
  const normalized = pipeline.normalize(rawDraft, source);
  const placed = placeLeftovers(normalized.draft, source);
  const lined = linesToTasks(placed, source, TODAY, { onlyDone: false });
  const checked = checkPlan(pipeline.decide(lined.draft, [], new Set()));
  return { draft: lined.draft, corrections: [...normalized.corrections, ...lined.corrections, ...checked.corrections] };
}

before(async () => {
  installStubs(loadCookies());
  ({ confirmImport } = await import("@/app/actions/import"));
  pipeline = await import("@/lib/import/draft");
  ({ check: checkPlan } = await import("@/lib/import/check"));
  ({ placeLeftovers } = await import("@/lib/import/coverage"));
  ({ linesToTasks } = await import("@/lib/import/line-tasks"));
  ({ todayInZone } = await import("@/lib/zone"));
  TODAY = todayInZone();
});

after(async () => {
  if (goalIds.length > 0) await sql`delete from goals.goals where id in ${sql(goalIds)}`;
  await sql.end();
});

test("confirmImport: a monthless task in a goal with a rhythm is in the plan with no fixed month", async () => {
  const { draft, corrections } = read(raw(`M14 fixture ${RUN}: ritmo`, true));
  assert.deepEqual(corrections.filter((c) => c.at === "goals.0.tasks.0"), []);
  const result = await confirmImport(pipeline.decide(draft, corrections, new Set()));
  if (!result.ok) assert.fail(`confirmImport: ${result.error} at ${result.at}`);
  goalIds.push(...result.goalIds);
  const rows = await sql`select name, planned_month::text as planned_month, in_plan from goals.one_offs where goal_id = ${result.goalIds[0]}`;
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: "Leer", planned_month: null, in_plan: true }]);
});

test("confirmImport: with no rhythm the accepted proposal writes the task into the current month", async () => {
  const { draft, corrections } = read(raw(`M14 fixture ${RUN}: sin ritmo`, false));
  const result = await confirmImport(pipeline.decide(draft, corrections, new Set()));
  if (!result.ok) assert.fail(`confirmImport: ${result.error} at ${result.at}`);
  goalIds.push(...result.goalIds);
  const rows = await sql`select name, planned_month::text as planned_month from goals.one_offs where goal_id = ${result.goalIds[0]}`;
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: "Leer", planned_month: `${TODAY.slice(0, 7)}-01` }]);
});

test("confirmImport: with no rhythm a declined proposal writes nothing and names the task", async () => {
  const name = `M14 fixture ${RUN}: rechazada`;
  const { draft, corrections } = read(raw(name, false));
  const proposal = corrections.find((c) => c.at === "goals.0.tasks.0" && c.proposed === TODAY.slice(0, 7));
  assert.ok(proposal, "a proposal for the monthless task");
  const result = await confirmImport(pipeline.decide(draft, corrections, new Set([proposal.id])));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.at, "goals.0.tasks.0");
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from goals.goals where name = ${name}`;
  assert.equal(count, 0);
});
