// Proves RP-56 and RNP-15 for `declare_fact`: the contract carries no
// `replace`, a client's `replace: true` is dropped at the edge and a day
// already noted answers the fact that was there, the description says so, and
// a tool that fails logs its error's name and SQLSTATE and never the driver's
// message. Handlers are called in-process as `write-tools.ts` calls them, but
// through the registered `inputSchema` first, the way the SDK parses a call.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { todayInZone } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";

type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
type Registered = { description: string; inputSchema: import("zod").ZodObject<import("zod").ZodRawShape>; handler: Handler };

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

const registered = new Map<string, Registered>();
let session: typeof import("@/lib/session");
let plan: typeof import("@/app/actions/plan");
let subject: Person;
let commitment: string;
let goalId: string;

const today = todayInZone();
const asResolved = (person: { id: string; email: string }): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const ctxOf = (person: { id: string; email: string }): ServerContext =>
  ({ http: { authInfo: { extra: { person: asResolved(person) } } } }) as unknown as ServerContext;

function dayFrom(delta: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function call(name: string, input: Record<string, unknown>, person: { id: string; email: string } = subject) {
  const tool = registered.get(name);
  assert.ok(tool, `${name} is not registered`);
  return tool.handler(tool.inputSchema.parse(input), ctxOf(person));
}

before(async () => {
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
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerWriteTools({
    registerTool: (name: string, config: { description: string; inputSchema: Registered["inputSchema"] }, handler: Handler) =>
      void registered.set(name, { description: config.description, inputSchema: config.inputSchema, handler }),
  } as unknown as McpServer);

  const runId = await openCheckRun(admin);
  [subject] = await createPeople(admin, runId, door, 1);

  await session.actAs(asResolved(subject), async () => {
    const goal = await plan.createGoal({ name: "sin replace", horizon: dayFrom(120) });
    if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
    goalId = goal.goalId;
    const made = await plan.addCommitment({
      goalId,
      name: "estudiar",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never);
    if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
    commitment = made.commitmentId;
  });
  // A past day is only open to a commitment that already existed that day.
  await admin`update goals.commitments set created_at = now() - interval '20 days' where id = ${commitment}`;
  await admin`update goals.goals set created_at = now() - interval '20 days' where id = ${goalId}`;
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("declare_fact's contract has no replace, and its description says a noted day is left alone", () => {
  const tool = registered.get("declare_fact");
  assert.ok(tool);
  assert.equal("replace" in tool.inputSchema.shape, false);
  assert.deepEqual(Object.keys(tool.inputSchema.shape).sort(), ["commitment_id", "day", "note", "one_off_id", "quantity"]);
  assert.ok(tool.description.includes("Si ese día ya está anotado, no cambia nada: corregir la cantidad se hace en la app."));
  assert.ok(tool.description.includes("Nunca borra."));
  assert.equal(tool.description, mcp.tools.declare_fact);
});

test("replace: true does not delete: the same fact answers, with its quantity and its note", async () => {
  const day = dayFrom(-5);
  const first = await call("declare_fact", { commitment_id: commitment, quantity: 30, note: "n", day });
  assert.equal(first.isError, undefined);
  const factId = first.structuredContent?.factId;
  assert.equal(typeof factId, "string");

  const again = await call("declare_fact", { commitment_id: commitment, quantity: 45, replace: true, day });
  assert.notEqual(again.isError, true);
  assert.equal(again.structuredContent?.ok, true);
  assert.equal(again.structuredContent?.factId, factId);

  const rows = await door`select id, quantity, note from goals.facts where commitment_id = ${commitment} and day = ${day}`;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].quantity, rows[0].note], [factId, 30, "n"]);
});

test("a tool that fails logs the error's name and SQLSTATE, never the driver's message", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  let result;
  try {
    // A person id that is no uuid fails inside Postgres once a real row makes the policy run; drizzle's message carries the query and the parameter.
    result = await call("declare_fact", { commitment_id: commitment, quantity: 5, day: dayFrom(-6) }, {
      id: "no-es-un-uuid-0000",
      email: "x@example.invalid",
    });
  } finally {
    console.error = original;
  }
  assert.equal(result.isError, true);
  assert.equal(logged.length, 1, "exactly one failure was logged");
  const line = logged[0].map(String).join(" ");
  assert.ok(line.startsWith("mcp write tool failed:"));
  assert.doesNotMatch(line, /select|insert|update|from |\$1|no-es-un-uuid/i);
  assert.match(line, /\b22P02\b/);
});
