// M8 (RP-56): an AI that re-sends `create_task` with the same `request_id`
// after a lost answer gets the first answer back and one task. Handlers are
// called in-process as `declare-no-replace.ts` calls them, through the
// registered `inputSchema` first, the way the SDK parses a call.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { todayInZone } from "@/lib/zone";

type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
type Registered = { inputSchema: import("zod").ZodObject<import("zod").ZodRawShape>; handler: Handler };

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

const registered = new Map<string, Registered>();
let subject: Person;
const today = todayInZone();
const RUN = randomUUID().slice(0, 8);

const ctxOf = (person: { id: string; email: string }): ServerContext =>
  ({ http: { authInfo: { extra: { person: { id: person.id, email: person.email } as ResolvedPerson } } } }) as unknown as ServerContext;

async function call(name: string, input: Record<string, unknown>) {
  const tool = registered.get(name);
  assert.ok(tool, `${name} is not registered`);
  return tool.handler(tool.inputSchema.parse(input), ctxOf(subject));
}

async function tasksNamed(name: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from goals.one_offs where user_id = ${subject.id} and name = ${name}`;
  return row.n;
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
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerWriteTools({
    registerTool: (name: string, config: { inputSchema: Registered["inputSchema"] }, handler: Handler) =>
      void registered.set(name, { inputSchema: config.inputSchema, handler }),
  } as unknown as McpServer);
  const runId = await openCheckRun(admin);
  [subject] = await createPeople(admin, runId, door, 1);
});

after(async () => {
  try {
    if (subject) {
      await admin`delete from goals.write_receipts where user_id = ${subject.id}`;
      await admin`delete from goals.one_offs where user_id = ${subject.id}`;
    }
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("create_task sent twice with the same request_id makes one task and answers it both times", async () => {
  const name = `M8 por la IA ${RUN}`;
  const request_id = randomUUID();
  const first = await call("create_task", { name, day: today, request_id });
  const second = await call("create_task", { name, day: today, request_id });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(typeof first.structuredContent?.oneOffId, "string");
  assert.deepEqual(second.structuredContent, first.structuredContent);
  assert.equal(await tasksNamed(name), 1);
});

test("create_task with two different request_ids makes two tasks", async () => {
  const name = `M8 dos pedidos ${RUN}`;
  const first = await call("create_task", { name, day: today, request_id: randomUUID() });
  const second = await call("create_task", { name, day: today, request_id: randomUUID() });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.notEqual(second.structuredContent?.oneOffId, first.structuredContent?.oneOffId);
  assert.equal(await tasksNamed(name), 2);
});
