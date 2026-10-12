// Proves RP-85, RP-95, RP-39 and RP-56 for the tree tools: a connected AI reads
// the goal above and the goals below, creates inside, moves and writes the
// note through the acts the screen runs, and meets the screen's own refusals
// with their sentence and key. Each handler is called in-process with a stub
// `ctx` that carries a person the way `withMcpAuth` will; statements come off
// the wire as `write-tools.ts` counts them.
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
type Call = { connection: number; query: string };

const admin = adminSql();
const wire: Call[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 4,
  debug: (connection: number, query: string) => void wire.push({ connection, query }),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const handlers = new Map<string, Handler>();
let session: typeof import("@/lib/session");
let plan: typeof import("@/app/actions/plan");
let budgets: typeof import("@/app/actions/budgets");
let queries: typeof import("@/lib/queries/goal");
let subject: Person;
let intruder: Person;
// general > large (g1) > small (p); g2 is the second large one.
let general: string;
let g1: string;
let g2: string;
let small: string;
let intruderGoal: string;

const today = todayInZone();
const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const ctxOf = (person: Person): ServerContext =>
  ({ http: { authInfo: { extra: { person: asResolved(person) } } } }) as unknown as ServerContext;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

function dayFrom(delta: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const TYPE_FETCH =
  "select b.oid, b.typarray from pg_catalog.pg_type a left join pg_catalog.pg_type b " +
  "on b.oid = a.typelem where a.typcategory = 'a' group by b.oid, b.typarray order by b.oid";

function statements(calls: Call[]): number {
  return calls.filter((call) => {
    const text = call.query.replace(/\s+/g, " ").trim().toLowerCase();
    return !text.startsWith("begin") && text !== "commit" && text !== "rollback" && text !== TYPE_FETCH;
  }).length;
}

async function call(name: string, input: Record<string, unknown>, person: Person = subject) {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} is not registered`);
  return handler(input, ctxOf(person));
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
  assert.equal(result.structuredContent, undefined);
}

async function made(goal: Promise<{ ok: true; goalId: string } | { ok: false; error: string }>): Promise<string> {
  const result = await goal;
  if (!result.ok) throw new Error(`createGoal: ${result.error}`);
  return result.goalId;
}

type Shaped = {
  id: string;
  name: string;
  parent: { id: string; name: string } | null;
  children: { id: string; name: string; level: string }[];
  level: string | null;
  holdsGoals: boolean;
  note: string | null;
  rhythm: unknown;
  thisMonth: { month: string; planned: { value: number } | null; reached: { value: number } } | null;
};

async function read(id: string): Promise<Shaped> {
  return (await succeeds("get_goal", { goal_id: id })) as unknown as Shaped;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  budgets = await import("@/app/actions/budgets");
  queries = await import("@/lib/queries/goal");
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer;
  registerReadTools(server);
  registerWriteTools(server);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);

  await as(subject, async () => {
    general = await made(plan.createGoal({ name: "Gran", horizon: dayFrom(200) }));
    g1 = await made(plan.createGoal({ name: "Uno", horizon: dayFrom(150), parentId: general }));
    g2 = await made(plan.createGoal({ name: "Dos", horizon: dayFrom(160), parentId: general }));
    small = await made(plan.createGoal({ name: "Pequeña", horizon: dayFrom(100), parentId: g1 }));
    const commitment = await plan.addCommitment({
      goalId: small,
      name: "estudiar",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    const budget = await budgets.setMonthBudget({ goalId: small, month: today.slice(0, 7), amount: 600 });
    if (!budget.ok) throw new Error(`setMonthBudget: ${budget.error}`);
  });
  await as(intruder, async () => {
    intruderGoal = await made(plan.createGoal({ name: "Ajena", horizon: dayFrom(120) }));
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

test("get_goal reads the goal above and the goals below by name", async () => {
  assert.deepEqual((await read(small)).parent, { id: g1, name: "Uno" });
  const top = await read(general);
  assert.equal(top.parent, null);
  assert.deepEqual(
    top.children.map((child) => [child.id, child.name]),
    [
      [g1, "Uno"],
      [g2, "Dos"],
    ],
  );
  assert.deepEqual([top.level, top.holdsGoals, (await read(small)).level], ["general", true, "small"]);
});

test("get_goal gives the figures the screen draws, and no rhythm to a goal that holds goals", async () => {
  const top = await read(general);
  const screen = await as(subject, () => queries.loadGoal(general));
  assert.ok(screen?.month, "the screen has a month line");
  assert.ok(screen.month.planned !== null && screen.month.planned > 0, "the month line carries an amount");
  assert.equal(top.thisMonth?.month, screen.month.month.slice(0, 7));
  assert.equal(top.thisMonth?.planned?.value, screen.month.planned);
  assert.equal(top.thisMonth?.reached.value, screen.month.reached);
  assert.equal(top.rhythm, null);
});

test("list_goals walks the tree in the screen's order with each goal's parent and children", async () => {
  const listed = (await succeeds("list_goals", {})) as unknown as {
    open: { id: string; name: string; parentId: string | null; level: string | null; childIds: string[] }[];
  };
  assert.deepEqual(
    listed.open.map((goal) => goal.id),
    [general, g1, small, g2],
  );
  assert.deepEqual(
    listed.open.map((goal) => goal.parentId),
    [null, general, g1, general],
  );
  assert.deepEqual(listed.open[0].childIds, [g1, g2]);
  assert.equal(listed.open[0].level, "general");
});

test("create_goal with parent_id writes the row inside that goal", async () => {
  const result = await succeeds("create_goal", { name: "Dentro", horizon: dayFrom(90), parent_id: g2 });
  const [row] = await door`select parent_id from goals.goals where id = ${result.goalId as string}`;
  assert.equal(row.parent_id, g2);
  assert.deepEqual((await read(result.goalId as string)).parent, { id: g2, name: "Dos" });
});

test("create_goal inside a small goal is refused with the screen's key and sentence", async () => {
  const before = (await door`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n;
  await refused("create_goal", { name: "Nieta", horizon: dayFrom(50), parent_id: small }, "tree.errors.tooDeep", tree.errors.tooDeep);
  const after = (await door`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n;
  assert.equal(after, before);
});

test("an end past the goal above is refused with that goal's name and its last day", async () => {
  const date = `${civilDayMonthShort(dayFrom(159))} ${dayFrom(159).slice(0, 4)}`;
  await refused(
    "create_goal",
    { name: "Larga", horizon: dayFrom(170), parent_id: g2 },
    "tree.errors.endPastAbove",
    tree.errors.endPastAbove.replace("{name}", "Dos").replace("{date}", date),
  );
});

test("a goal of another person is not found, and nothing of theirs moves", async () => {
  await refused("create_goal", { name: "x", horizon: dayFrom(10), parent_id: intruderGoal }, "tree.errors.notFound", tree.errors.notFound);
  await refused("move_goal", { goal_id: small, parent_id: intruderGoal }, "tree.errors.notFound", tree.errors.notFound);
  const foreign = await call("get_goal", { goal_id: intruderGoal });
  assert.equal(body(foreign).key, "mcp.errors.goalNotFound");
  const [row] = await admin`select parent_id, note from goals.goals where id = ${intruderGoal}`;
  assert.deepEqual([row.parent_id, row.note], [null, null]);
});

test("move_goal under its own branch is refused as a cycle", async () => {
  await refused("move_goal", { goal_id: general, parent_id: small }, "tree.errors.cycle", tree.errors.cycle);
});

test("move_goal with a null parent makes the goal a root", async () => {
  await succeeds("move_goal", { goal_id: small, parent_id: null });
  const [row] = await door`select parent_id from goals.goals where id = ${small}`;
  assert.equal(row.parent_id, null);
  assert.equal((await read(small)).parent, null);
  await succeeds("move_goal", { goal_id: small, parent_id: g1 });
  assert.deepEqual((await read(small)).parent, { id: g1, name: "Uno" });
});

test("set_goal_note and get_goal.note round-trip, line breaks included, and a blank note is refused", async () => {
  const note = "primera línea\n\nsegunda línea\n  con sangría";
  await succeeds("set_goal_note", { goal_id: g1, note });
  assert.equal((await read(g1)).note, note);
  await refused("set_goal_note", { goal_id: g1, note: "  \n " }, "mcp.errors.noteEmpty", mcp.errors.noteEmpty);
  assert.equal((await read(g1)).note, note);
  await refused("set_goal_note", { goal_id: g1, note: "x".repeat(20001) }, "tree.errors.noteTooLong", tree.errors.noteTooLong);
  assert.equal((await read(g1)).note, note);
});

test("the tools are twenty-two and none deletes, archives, removes, undoes or revokes", () => {
  const names = [...handlers.keys()];
  assert.equal(names.length, 22, names.join(","));
  assert.deepEqual(names.filter((name) => /delete|archive|remove|undo|revoke/.test(name)), []);
  for (const name of ["move_goal", "set_goal_note"]) assert.ok(names.includes(name), `${name} missing`);
});

test("each tree tool issues the statements of its act or loader and no more", async () => {
  const cases: { tool: string; input: () => Record<string, unknown>; direct: (i: Record<string, unknown>) => Promise<unknown> }[] = [
    {
      tool: "get_goal",
      input: () => ({ goal_id: general }),
      direct: () => queries.loadGoal(general),
    },
    {
      tool: "list_goals",
      input: () => ({}),
      direct: () => queries.listGoalsForMetas(),
    },
    {
      tool: "create_goal",
      input: () => ({ name: "medida", horizon: dayFrom(80), parent_id: g2 }),
      direct: () => plan.createGoal({ name: "medida", horizon: dayFrom(80), parentId: g2 }),
    },
    {
      tool: "move_goal",
      input: () => ({ goal_id: small, parent_id: g1 }),
      direct: () => plan.moveGoal({ goalId: small, parentId: g1 }),
    },
    {
      tool: "set_goal_note",
      input: () => ({ goal_id: g2, note: "medida" }),
      direct: () => plan.setGoalNote({ goalId: g2, note: "medida" }),
    },
  ];
  for (const { tool, input, direct } of cases) {
    await call(tool, input()); // warm the pool and its type fetch
    let mark = wire.length;
    await as(subject, () => direct(input()));
    const actual = statements(wire.slice(mark));
    mark = wire.length;
    const result = await call(tool, input());
    assert.notEqual(result.isError, true, `${tool} failed: ${result.content[0]?.text}`);
    const viaTool = statements(wire.slice(mark));
    assert.ok(actual > 0, `${tool} measured nothing`);
    assert.equal(viaTool, actual, `${tool}: ${viaTool} statements through the tool, ${actual} direct`);
  }
});
