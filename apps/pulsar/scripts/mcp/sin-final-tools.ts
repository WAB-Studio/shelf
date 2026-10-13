// Proves RP-99, RP-100 and RP-101 for the tools: a connected AI (RP-39, RP-56)
// creates a goal with no end, gives it one but never takes it away, creates a
// habit with no goal and reads both back, and meets the screen's own refusals
// with their sentence and key. Each handler is called in-process with a stub
// `ctx` that carries a person the way `withMcpAuth` will.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { civilDayMonthShort, todayInZone } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";
import tree from "../../messages/es/tree.json";

type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

const handlers = new Map<string, Handler>();
let session: typeof import("@/lib/session");
let plan: typeof import("@/app/actions/plan");
let subject: Person;
// A goal with an end, and a goal with none.
let dated: string;
let endless: string;

const today = todayInZone();
const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const ctxOf = (person: Person): ServerContext =>
  ({ http: { authInfo: { extra: { person: asResolved(person) } } } }) as unknown as ServerContext;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

function dayFrom(delta: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function call(name: string, input: Record<string, unknown>) {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} is not registered`);
  return handler(input, ctxOf(subject));
}

const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

async function succeeds(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(name, input);
  assert.notEqual(result.isError, true, `${name} failed: ${result.content[0]?.text}`);
  assert.ok(result.structuredContent, `${name} answered no structuredContent`);
  return result.structuredContent;
}

async function refused(name: string, input: Record<string, unknown>, key: string, sentence: string) {
  const result = await call(name, input);
  assert.equal(result.isError, true, `${name} did not refuse`);
  assert.deepEqual(body(result), { key, message: sentence });
}

type Shaped = { horizon: string | null; endedOn: string | null };
type Habit = { id: string; name: string };

const read = async (id: string) => (await succeeds("get_goal", { goal_id: id })) as unknown as Shaped;

before(async () => {
  stubServerOnly();
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer;
  registerReadTools(server);
  registerWriteTools(server);

  const runId = await openCheckRun(admin);
  [subject] = await createPeople(admin, runId, door, 1);
  await as(subject, async () => {
    const made = await plan.createGoal({ name: "Con final", horizon: dayFrom(100) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    dated = made.goalId;
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

test("create_goal without a horizon opens a goal with no end, read back as null", async () => {
  const result = await succeeds("create_goal", { name: "Cuidado personal" });
  endless = result.goalId as string;
  const [row] = await door`select horizon from goals.goals where id = ${endless}`;
  assert.equal(row.horizon, null);
  assert.deepEqual(await read(endless), { ...(await read(endless)), horizon: null, endedOn: null });
});

test("create_goal with no end inside a goal with one is refused with the screen's key and sentence", async () => {
  const date = `${civilDayMonthShort(dayFrom(99))} ${dayFrom(99).slice(0, 4)}`;
  await refused(
    "create_goal",
    { name: "Sin final dentro", parent_id: dated },
    "tree.errors.endPastAbove",
    tree.errors.endPastAbove.replace("{name}", "Con final").replace("{date}", date),
  );
});

test("move_horizon gives a goal with no end its first, and the AI cannot take it away", async () => {
  const end = dayFrom(60);
  await succeeds("move_horizon", { goal_id: endless, horizon: end });
  assert.equal((await read(endless)).horizon, end);
  await refused("move_horizon", { goal_id: endless, horizon: null }, "mcp.errors.endKept", mcp.errors.endKept);
  assert.equal((await read(endless)).horizon, end);
  await refused("move_horizon", { goal_id: endless }, "mcp.errors.endKept", mcp.errors.endKept);
});

test("add_commitment without goal_id creates a habit with no goal that get_today and list_goals read", async () => {
  const result = await succeeds("add_commitment", {
    name: "Bañarse",
    cadence_kind: "daily",
    satisfaction: "tap",
  });
  assert.ok(result.commitmentId, "the act names the new commitment");
  const [row] = await door`select goal_id from goals.commitments where id = ${result.commitmentId as string}`;
  assert.equal(row.goal_id, null);
  const todayView = (await succeeds("get_today", {})) as unknown as {
    loose: { commitments: Habit[]; slots: { commitmentId: string }[] };
  };
  assert.deepEqual(todayView.loose.commitments.map((habit) => habit.name), ["Bañarse"]);
  assert.deepEqual(todayView.loose.slots.map((slot) => slot.commitmentId), [result.commitmentId]);
  const listed = (await succeeds("list_goals", {})) as unknown as { looseHabits: Habit[] };
  assert.deepEqual(listed.looseHabits.map((habit) => habit.name), ["Bañarse"]);
});

test("list_goals shows a goal with no end as horizon null", async () => {
  const noEnd = await succeeds("create_goal", { name: "Leer" });
  const listed = (await succeeds("list_goals", {})) as unknown as { open: { id: string; horizon: string | null }[] };
  assert.equal(listed.open.find((goal) => goal.id === noEnd.goalId)?.horizon, null);
});

test("no tool changes a rhythm (RP-56)", () => {
  assert.deepEqual([...handlers.keys()].filter((name) => /rhythm|ritmo/.test(name)), []);
});

test("the tools' input schemas accept no horizon, a null horizon and no goal_id", async () => {
  const { writeTools } = await import("@/lib/tools/catalogue");
  const accepts = (tool: string, input: Record<string, unknown>) =>
    writeTools.find((spec) => spec.name === tool)!.input.safeParse(input).success;
  assert.equal(accepts("create_goal", { name: "Leer" }), true);
  assert.equal(accepts("move_horizon", { goal_id: "g", horizon: null }), true);
  assert.equal(accepts("add_commitment", { name: "Bañarse", cadence_kind: "daily", satisfaction: "tap" }), true);
});
