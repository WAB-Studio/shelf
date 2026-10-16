// Drives migration 0014 (RP-20, RP-50): a row of a goal with no day is a task of
// its plan at every write — Hoy's `createOneOff`, MCP `create_task`, a direct
// insert through RLS as `authenticated` — and a goalless or dated row is not.
// The backfill is the migration's own `UPDATE`, read from the file and run on
// rows planted the way 0013 left them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
(globalThis as unknown as { sql: unknown }).sql = door;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "./reading-lookups") return { readReadingLookups: async () => [] };
    return originalLoad(request, parent, isMain);
  };
}

type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { text: string }[];
}>;

let session: typeof import("@/lib/session");
let oneOffs: typeof import("@/app/actions/one-offs");
let plan: typeof import("@/app/actions/plan");
let roadmap: typeof import("@/app/actions/roadmap");
let queries: typeof import("@/lib/queries/goal");
let owner: Person;
let today: string;
let goalId: string;
let rhythmGoalId: string;
const handlers = new Map<string, Handler>();
const goalIds: string[] = [];

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(fn: () => Promise<T>) => session.actAs(asResolved(owner), fn);

async function inPlanOf(id: string): Promise<{ inPlan: boolean; day: string | null }> {
  const [row] = await admin<{ in_plan: boolean; day: string | null }[]>`
    select in_plan, day::text as day from goals.one_offs where id = ${id}`;
  return { inPlan: row.in_plan, day: row.day };
}

async function created(input: Parameters<typeof oneOffs.createOneOff>[0]): Promise<string> {
  const made = await as(() => oneOffs.createOneOff(input));
  if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
  return made.oneOffId;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  oneOffs = await import("@/app/actions/one-offs");
  plan = await import("@/app/actions/plan");
  roadmap = await import("@/app/actions/roadmap");
  queries = await import("@/lib/queries/goal");
  today = (await import("@/lib/zone")).todayInZone();
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerWriteTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer);
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 120);
  const horizonDay = horizon.toISOString().slice(0, 10);
  for (const name of ["sin ritmo", "con ritmo"]) {
    const goal = await as(() => plan.createGoal({ name, horizon: horizonDay }));
    if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
    goalIds.push(goal.goalId);
  }
  [goalId, rhythmGoalId] = goalIds;
  const commitment = await as(() =>
    plan.addCommitment({
      goalId: rhythmGoalId,
      name: "minutos",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit: "minutos",
    }),
  );
  if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
  const rhythm = await as(() => roadmap.setRhythm({ goalId: rhythmGoalId, amount: 720 }));
  assert.deepEqual(rhythm, { ok: true });
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await admin`delete from goals.one_offs where user_id = ${owner.id}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("Hoy's write: a goal's task with no day lands in its plan", async () => {
  const id = await created({ name: "de la meta", day: null, goalId });
  assert.deepEqual(await inPlanOf(id), { inPlan: true, day: null });
});

test("MCP create_task with a goal_id and no day lands in the plan", async () => {
  const handler = handlers.get("create_task");
  assert.ok(handler, "create_task is not registered");
  const ctx = { http: { authInfo: { extra: { person: asResolved(owner) } } } } as unknown as ServerContext;
  const result = await handler({ name: "por MCP", goal_id: goalId }, ctx);
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(await inPlanOf(result.structuredContent!.oneOffId as string), { inPlan: true, day: null });
});

test("a direct insert as authenticated with the person's JWT lands in the plan", async () => {
  const claims = JSON.stringify({ sub: owner.id, role: "authenticated" });
  const rows = await door.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`set local role authenticated`;
    return tx<{ id: string; in_plan: boolean }[]>`
      insert into goals.one_offs (user_id, goal_id, name) values (${owner.id}, ${goalId}, 'directa')
      returning id, in_plan`;
  });
  assert.equal(rows[0].in_plan, true);
  assert.deepEqual(await inPlanOf(rows[0].id), { inPlan: true, day: null });
});

test("a goalless dayless row stays a suelta and the insert succeeds", async () => {
  const id = await created({ name: "suelta", day: null });
  assert.deepEqual(await inPlanOf(id), { inPlan: false, day: null });
});

test("a goal's dated row is untouched", async () => {
  const id = await created({ name: "con día", day: today, goalId });
  assert.deepEqual(await inPlanOf(id), { inPlan: false, day: today });
});

test("the plan lists it: unplaced with no rhythm, in the current month with one", async () => {
  const loose = await created({ name: "sin ritmo t", day: null, goalId });
  const view = await as(() => queries.loadGoal(goalId, today));
  assert.ok(view);
  assert.ok(view.roadmap.unplaced.some((item) => item.task.id === loose));

  const placed = await created({ name: "con ritmo t", day: null, goalId: rhythmGoalId, estimate: 30 });
  const rhythmView = await as(() => queries.loadGoal(rhythmGoalId, today));
  assert.ok(rhythmView);
  const month = rhythmView.roadmap.months.find((entry) => entry.month.startsWith(today.slice(0, 7)));
  assert.ok(month?.items.some((item) => item.task.id === placed));
});

test("the backfill moves a goal's dayless row of 0013 and nothing else", async () => {
  const sql = readFileSync(new URL("../../db/migrations/0014_goal_task_no_day_in_plan.sql", import.meta.url), "utf8");
  const update = sql.split("--> statement-breakpoint").map((part) => part.trim()).find((part) => /^(--.*\n)*UPDATE/i.test(part));
  assert.ok(update, "the migration has no UPDATE");

  const legacy = await created({ name: "heredada", day: null, goalId });
  const done = await created({ name: "heredada hecha", day: null, goalId });
  const goalless = await created({ name: "suelta heredada", day: null });
  const dated = await created({ name: "fechada heredada", day: today, goalId });
  await admin`update goals.one_offs set in_plan = false where id in ${admin([legacy, done])}`;
  await admin`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${owner.id}, ${goalId}, ${done}, ${today})`;

  await admin.unsafe(update);

  assert.equal((await inPlanOf(legacy)).inPlan, true);
  assert.equal((await inPlanOf(done)).inPlan, true);
  assert.equal((await inPlanOf(goalless)).inPlan, false);
  assert.equal((await inPlanOf(dated)).inPlan, false);
  const [left] = await admin<{ n: number }[]>`
    select count(*)::int as n from goals.one_offs
    where goal_id is not null and day is null and planned_month is null and parent_id is null and not in_plan`;
  assert.equal(left.n, 0);
});
