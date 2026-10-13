// Proves RP-39, RNP-03, RNP-12 and RNP-14 for the read tools: each handler,
// called in-process with a stub `ctx` that carries a person the way
// `withMcpAuth` will, answers its shape under the subject and runs exactly
// the statements its loader runs. Statements come off the wire as
// `scripts/plan/report.ts` counts them: a connection's bracket and its
// first-use type fetch are netted out, two connections overlap when their
// windows do.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { todayInZone } from "@/lib/zone";

type Call = { at: number; connection: number; query: string };
type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

const admin = adminSql();
const wire: Call[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 4,
  debug: (connection: number, query: string) => void wire.push({ at: Date.now(), connection, query }),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const handlers = new Map<string, Handler>();
let session: typeof import("@/lib/session");
let plan: typeof import("@/app/actions/plan");
let budgets: typeof import("@/app/actions/budgets");
let oneOffs: typeof import("@/app/actions/one-offs");
let subject: Person;
let intruder: Person;
let subjectGoal: string;
let intruderGoal: string;
let currentMonth: string;
let nextMonth: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const ctxOf = (person: Person): ServerContext =>
  ({ http: { authInfo: { extra: { person: asResolved(person) } } } }) as unknown as ServerContext;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => [], set() {} }) };
    }
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// Counted from the zone's today: from 19:00 in Bogotá the UTC date is already tomorrow.
function dayFrom(delta: number): string {
  return new Date(Date.parse(`${todayInZone()}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

const TYPE_FETCH =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b " +
  "on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid";

type Wire = { statements: number; connections: number; overlap: boolean };

function readWire(calls: Call[]): Wire {
  const byConnection = new Map<number, Call[]>();
  for (const call of calls) byConnection.set(call.connection, [...(byConnection.get(call.connection) ?? []), call]);
  let statements = 0;
  const windows: { start: number; end: number }[] = [];
  for (const group of byConnection.values()) {
    statements += group.filter((call) => {
      const text = call.query.replace(/\s+/g, " ").trim().toLowerCase();
      return !text.startsWith("begin") && text !== "commit" && text !== "rollback" && text !== TYPE_FETCH;
    }).length;
    const times = group.map((call) => call.at);
    windows.push({ start: Math.min(...times), end: Math.max(...times) });
  }
  const [a, b] = windows;
  return { statements, connections: byConnection.size, overlap: windows.length === 2 && a.start <= b.end && b.start <= a.end };
}

async function call(name: string, input: Record<string, unknown>, person: Person = subject) {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} is not registered`);
  return handler(input, ctxOf(person));
}

async function measured(name: string, input: Record<string, unknown>): Promise<Wire> {
  await call(name, input); // warm the pool and its type fetch
  const before = wire.length;
  const result = await call(name, input);
  assert.notEqual(result.isError, true, `${name} failed: ${result.content[0]?.text}`);
  return readWire(wire.slice(before));
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  budgets = await import("@/app/actions/budgets");
  oneOffs = await import("@/app/actions/one-offs");
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  registerReadTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);

  const today = dayFrom(0);
  currentMonth = monthFrom(today, 0);
  nextMonth = monthFrom(today, 1);

  await session.actAs(asResolved(subject), async () => {
    const made = await plan.createGoal({ name: "leer tools", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    subjectGoal = made.goalId;
    const commitment = await plan.addCommitment({
      goalId: subjectGoal,
      name: "estudiar",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    for (const [month, amount] of [[currentMonth, 750], [nextMonth, 300]] as const) {
      const budget = await budgets.setMonthBudget({ goalId: subjectGoal, month, amount });
      if (!budget.ok) throw new Error(`setMonthBudget: ${budget.error}`);
    }
    const task = await oneOffs.createOneOff({
      name: "tarea del mes",
      day: null,
      goalId: subjectGoal,
      estimate: 60,
      plannedMonth: currentMonth,
    });
    if (!task.ok) throw new Error(`createOneOff month task: ${task.error}`);
    const dayless = await oneOffs.createOneOff({ name: "sin día", day: null });
    if (!dayless.ok) throw new Error(`createOneOff dayless: ${dayless.error}`);
    const scheduled = await oneOffs.createOneOff({ name: "con día", day: dayFrom(3) });
    if (!scheduled.ok) throw new Error(`createOneOff scheduled: ${scheduled.error}`);
  });

  await session.actAs(asResolved(intruder), async () => {
    const made = await plan.createGoal({ name: "ajena", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal intruder: ${made.error}`);
    intruderGoal = made.goalId;
  });
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("the six read tools are registered, and nothing else", () => {
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ["get_goal", "get_month", "get_report", "get_today", "list_goals", "list_loose_one_offs"],
  );
});

test("list_goals answers the subject's goal and never the intruder's", async () => {
  const result = await call("list_goals", {});
  const goals = result.structuredContent as { open: { id: string; name: string }[] };
  assert.deepEqual(goals.open.map((goal) => goal.id), [subjectGoal]);
  assert.equal(JSON.parse(result.content[0].text).open[0].name, "leer tools");
});

test("get_goal answers months as YYYY-MM and time as value, unit and text", async () => {
  const result = await call("get_goal", { goal_id: subjectGoal });
  assert.notEqual(result.isError, true);
  const goal = result.structuredContent as {
    months: { month: string; planned: { value: number; unit: string; text?: string } | null }[];
    tasks: { name: string; month: string; estimate: { value: number; unit: string; text?: string } }[];
  };
  assert.ok(goal.months.length > 0);
  for (const row of goal.months) assert.match(row.month, /^\d{4}-\d{2}$/);
  const current = goal.months.find((row) => row.month === currentMonth);
  assert.deepEqual(current?.planned, { value: 750, unit: "minutos", text: "12 h 30 min" });
  assert.equal(goal.tasks[0].month, currentMonth);
  assert.deepEqual(goal.tasks[0].estimate, { value: 60, unit: "minutos", text: "1 h" });
});

test("get_goal on the intruder's goal and on a stranger's id answers goalNotFound", async () => {
  for (const goal_id of [intruderGoal, "11111111-1111-4111-8111-111111111111"]) {
    const result = await call("get_goal", { goal_id });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.key, "mcp.errors.goalNotFound");
    assert.equal(body.message, "Esa meta no existe o no es de esta persona.");
    assert.equal(result.structuredContent, undefined);
  }
});

test("get_month answers the month as YYYY-MM with its task, and goalNotFound for the intruder's goal", async () => {
  const result = await call("get_month", { goal_id: subjectGoal, month: currentMonth });
  assert.notEqual(result.isError, true);
  const body = result.structuredContent as { month: string; goalId: string; items: { name: string; month: string }[] };
  assert.equal(body.month, currentMonth);
  assert.equal(body.goalId, subjectGoal);
  assert.deepEqual(body.items.map((item) => item.name), ["tarea del mes"]);

  const refused = await call("get_month", { goal_id: intruderGoal, month: currentMonth });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).key, "mcp.errors.goalNotFound");
});

test("get_today answers today's day", async () => {
  const result = await call("get_today", {});
  assert.notEqual(result.isError, true);
  const body = result.structuredContent as { day: string; goals: { id: string }[]; slots: unknown[] };
  assert.equal(body.day, todayInZone());
  assert.deepEqual(body.goals.map((goal) => goal.id), [subjectGoal]);
  assert.equal(body.slots.length, 1);
});

test("get_report answers the open goal with its months as YYYY-MM", async () => {
  const result = await call("get_report", {});
  assert.notEqual(result.isError, true);
  const body = result.structuredContent as { goals: { id: string; months: { month: string }[] }[] };
  assert.deepEqual(body.goals.map((goal) => goal.id), [subjectGoal]);
  for (const row of body.goals[0].months) assert.match(row.month, /^\d{4}-\d{2}$/);
});

test("list_loose_one_offs answers both lists", async () => {
  const result = await call("list_loose_one_offs", {});
  const body = result.structuredContent as { dayless: { name: string }[]; scheduled: { name: string; day: string }[] };
  assert.deepEqual(body.dayless.map((item) => item.name), ["sin día"]);
  assert.deepEqual(body.scheduled.map((item) => [item.name, item.day]), [["con día", dayFrom(3)]]);
});

test("every tool answers the same data to its text and its structuredContent", async () => {
  for (const [name, input] of [
    ["list_goals", {}],
    ["get_goal", { goal_id: subjectGoal }],
    ["get_today", {}],
  ] as const) {
    const result = await call(name, input);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, name);
  }
});

test("a call without a person in the context is refused as unauthorized and reads nothing", async () => {
  const handler = handlers.get("list_goals")!;
  const before = wire.length;
  const result = await handler({}, { http: { authInfo: { extra: {} } } } as unknown as ServerContext);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).key, "mcp.errors.unauthorized");
  assert.equal(wire.length, before);
});

test("each tool issues exactly its loader's statements", async () => {
  const counts = {
    list_goals: await measured("list_goals", {}),
    get_goal: await measured("get_goal", { goal_id: subjectGoal }),
    get_month: await measured("get_month", { goal_id: subjectGoal, month: currentMonth }),
    get_today: await measured("get_today", {}),
    get_report: await measured("get_report", {}),
    list_loose_one_offs: await measured("list_loose_one_offs", {}),
  };
  console.log(`wire: ${JSON.stringify(counts)}`);
  // `/metas` reads the evidence beside the goals, and the loose habits read in a third transaction.
  assert.equal(counts.list_goals.statements, 6);
  assert.equal(counts.get_goal.statements, 4);
  assert.equal(counts.get_month.statements, 4);
  assert.equal(counts.get_today.statements, 4);
  assert.equal(counts.get_report.statements, 4);
  assert.equal(counts.list_loose_one_offs.statements, 4);
});

test("the two loose lists run in overlapping transactions", async () => {
  const wireOf = await measured("list_loose_one_offs", {});
  assert.equal(wireOf.connections, 2);
  assert.equal(wireOf.overlap, true);
});

// RP-59: a goal's task with no day waits in its plan, never in the loose list.
test("list_loose_one_offs keeps a goal's dayless task out of dayless and a goal's task with a later day in scheduled", async () => {
  await session.actAs(asResolved(subject), async () => {
    const waiting = await oneOffs.createOneOff({ name: "tarea de meta sin día", day: null, goalId: subjectGoal });
    if (!waiting.ok) throw new Error(`createOneOff goal task: ${waiting.error}`);
    const later = await oneOffs.createOneOff({ name: "tarea de meta con día", day: dayFrom(4), goalId: subjectGoal });
    if (!later.ok) throw new Error(`createOneOff goal task later: ${later.error}`);
  });
  const result = await call("list_loose_one_offs", {});
  const body = result.structuredContent as { dayless: { name: string }[]; scheduled: { name: string; day: string }[] };
  assert.deepEqual(body.dayless.map((item) => item.name), ["sin día"]);
  assert.ok(body.scheduled.some((item) => item.name === "tarea de meta con día" && item.day === dayFrom(4)));
});

// RP-39, RP-56: the annotations of every registered tool, taken from the registry.
type Registered = { annotations?: Record<string, unknown>; inputSchema: { safeParse: (value: unknown) => { success: boolean } } };

async function registry(): Promise<Map<string, Registered>> {
  const seen = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered) => void seen.set(name, config),
  } as unknown as McpServer;
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerReadTools(server);
  registerWriteTools(server);
  return seen;
}

test("the registry holds twenty-two tools: six read and sixteen write, each with its annotations", async () => {
  const seen = await registry();
  assert.equal(seen.size, 22);
  const reads = new Set(handlers.keys());
  assert.equal(reads.size, 6);
  for (const [name, config] of seen) {
    const expected = reads.has(name)
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
      : { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    assert.deepEqual(config.annotations, expected, name);
  }
  assert.equal([...seen.keys()].filter((name) => !reads.has(name)).length, 16);
});

test("get_month refuses the month 2026-00 and never answers data", async () => {
  const config = (await registry()).get("get_month")!;
  assert.equal(config.inputSchema.safeParse({ goal_id: subjectGoal, month: "2026-00" }).success, false);
  assert.equal(config.inputSchema.safeParse({ goal_id: subjectGoal, month: currentMonth }).success, true);
});

test("get_report keeps every month of the goal, down to the horizon's with no amount (RP-39, RP-70)", async () => {
  const result = await call("get_report", {});
  const body = result.structuredContent as {
    goals: { months: { month: string; planned: number | null; past: boolean; current: boolean }[] }[];
  };
  const months = body.goals[0].months;
  const last = months[months.length - 1];
  assert.equal(last.month, dayFrom(120).slice(0, 7));
  assert.deepEqual([last.planned, last.past, last.current], [null, false, false]);
});

test("get_goal reads an ended goal's months as closed and an open goal's as they stand", async () => {
  let endedGoal = "";
  await session.actAs(asResolved(subject), async () => {
    const made = await plan.createGoal({ name: "terminada", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal ended: ${made.error}`);
    endedGoal = made.goalId;
  });
  // The horizon is the day after the goal's last: today ends it as of yesterday.
  await admin`update goals.goals set horizon = ${dayFrom(0)} where id = ${endedGoal}`;
  type Months = { month: string; current: boolean; past: boolean }[];
  const ended = (await call("get_goal", { goal_id: endedGoal })).structuredContent as { endedOn: string | null; months: Months };
  assert.notEqual(ended.endedOn, null);
  assert.ok(ended.months.length > 0);
  assert.equal(ended.months.some((row) => row.current), false);
  assert.ok(ended.months.every((row) => row.past));
  const open = (await call("get_goal", { goal_id: subjectGoal })).structuredContent as { months: Months };
  assert.equal(open.months.find((row) => row.month === currentMonth)?.current, true);
  assert.equal(open.months.find((row) => row.month === nextMonth)?.past, false);
});

test("get_report reads an ended goal's months as closed and an open goal's as they stand", async () => {
  type Months = { month: string; current: boolean; past: boolean }[];
  let endedGoal = "";
  await session.actAs(asResolved(subject), async () => {
    const made = await plan.createGoal({ name: "terminada en el reporte", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal ended: ${made.error}`);
    endedGoal = made.goalId;
  });
  await admin`update goals.goals set horizon = ${dayFrom(0)} where id = ${endedGoal}`;
  const result = await call("get_report", {});
  const goals = (result.structuredContent as { goals: { id: string; endedOn: string | null; months: Months }[] }).goals;
  const ended = goals.find((goal) => goal.id === endedGoal)!;
  assert.notEqual(ended.endedOn, null);
  assert.ok(ended.months.length > 0);
  assert.equal(ended.months.some((row) => row.current), false);
  assert.ok(ended.months.every((row) => row.past));
  const open = goals.find((goal) => goal.id === subjectGoal)!;
  assert.equal(open.months.find((row) => row.month === currentMonth)?.current, true);
  assert.equal(open.months.find((row) => row.month === nextMonth)?.past, false);
});
