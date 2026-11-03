// Proves RP-151 over /mcp: get_time reads the ledger and record_time places time
// through the acts the tray runs, source chat. Each handler
// is called in-process with a stub `ctx` that carries a person the way
// `withMcpAuth` will.
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

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

const handlers = new Map<string, Handler>();
let session: typeof import("@/lib/session");
let acts: { plan: typeof import("@/app/actions/plan") };
let subject: Person;
let intruder: Person;
let timeGoal: string;
let pagesGoal: string;
let intruderGoal: string;

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

async function call(name: string, input: Record<string, unknown>, person: Person = subject) {
  const handler = handlers.get(name);
  assert.ok(handler, `${name} is not registered`);
  return handler(input, ctxOf(person));
}

const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

async function succeeds(name: string, input: Record<string, unknown>) {
  const result = await call(name, input);
  assert.notEqual(result.isError, true, `${name} failed: ${result.content[0]?.text}`);
  return result.structuredContent;
}

async function refused(name: string, input: Record<string, unknown>, key: string, sentence: string, person?: Person) {
  const result = await call(name, input, person);
  assert.equal(result.isError, true, `${name} did not refuse`);
  assert.deepEqual(body(result), { key, message: sentence });
  assert.equal(result.structuredContent, undefined);
}


async function measuring(person: Person, name: string, unit: string): Promise<string> {
  return as(person, async () => {
    const made = await acts.plan.createGoal({ name, horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    const commitment = await acts.plan.addCommitment({
      goalId: made.goalId,
      name: `medir ${name}`,
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 5,
      unit,
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    return made.goalId;
  });
}

const entriesOf = (userId: string) =>
  admin<{ id: string; minutes: number; source: string; suggested: string | null; placed: number }[]>`
    select e.id, e.minutes, e.source, e.suggested_goal_id as suggested,
           coalesce((select sum(a.minutes)::int from goals.time_allocations a where a.entry_id = e.id), 0) as placed
      from goals.time_entries e where e.user_id = ${userId} order by e.day, e.minutes`;

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
  acts = { plan: await import("@/app/actions/plan") };
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer;
  registerReadTools(server);
  registerWriteTools(server);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  timeGoal = await measuring(subject, "Inglés", "minutos");
  pagesGoal = await measuring(subject, "Libro", "páginas");
  intruderGoal = await measuring(intruder, "Ajena", "minutos");
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("record_time with a time goal confirms the whole entry to it, source chat, and get_time reads it back", async () => {
  const result = await succeeds("record_time", { day: dayFrom(-1), minutes: 480, goal_id: timeGoal, note: "estudio" });
  assert.equal(result?.confirmed, true);
  const [entry] = await entriesOf(subject.id);
  assert.deepEqual([entry.minutes, entry.source, entry.placed], [480, "chat", 480]);
  const ledger = await succeeds("get_time", { from: dayFrom(-3), to: today });
  const days = ledger?.days as { day: string; goal: { id: string; name: string } | null; confirmed: { value: number; text: string } }[];
  assert.deepEqual(days.map((line) => [line.day, line.goal?.name, line.confirmed.value, line.confirmed.text]), [
    [dayFrom(-1), "Inglés", 480, "8 h"],
  ]);
});

test("record_time with no goal waits in the tray and get_time lists it as waiting with no goal", async () => {
  const result = await succeeds("record_time", { day: today, minutes: 45 });
  assert.equal(result?.confirmed, undefined);
  const waiting = (await entriesOf(subject.id)).find((entry) => entry.minutes === 45)!;
  assert.deepEqual([waiting.placed, waiting.suggested], [0, null]);
  const ledger = await succeeds("get_time", { from: today, to: today });
  assert.deepEqual(ledger?.waiting, { value: 45, unit: "minutos", text: "45 min" });
  assert.equal((ledger?.days as { goal: unknown }[])[0].goal, null);
});

test("record_time by a goal's exact name confirms it; an unknown name waits", async () => {
  await succeeds("record_time", { day: today, minutes: 20, goal_name: "inglés" });
  await succeeds("record_time", { day: today, minutes: 25, goal_name: "No existe" });
  const rows = await entriesOf(subject.id);
  assert.equal(rows.find((entry) => entry.minutes === 20)!.placed, 20);
  assert.equal(rows.find((entry) => entry.minutes === 25)!.placed, 0);
});

test("record_time on a goal that measures pages leaves the entry waiting and says why", async () => {
  const result = await succeeds("record_time", { day: today, minutes: 15, goal_id: pagesGoal });
  assert.deepEqual([result?.confirmed, result?.waitingBecause], [false, "day.errors.timeNotMeasured"]);
  const row = (await entriesOf(subject.id)).find((entry) => entry.minutes === 15)!;
  assert.deepEqual([row.placed, row.suggested], [0, pagesGoal]);
});

test("record_time on another person's goal is refused and records nothing", async () => {
  const before = (await entriesOf(subject.id)).length;
  await refused("record_time", { day: today, minutes: 30, goal_id: intruderGoal }, "day.errors.notFound", mcp.errors.byTool["record_time:day.errors.notFound"]);
  assert.equal((await entriesOf(subject.id)).length, before);
  assert.equal((await entriesOf(intruder.id)).length, 0);
});

test("get_time never reads another person's time, and record_time refuses a future day", async () => {
  await succeeds("record_time", { day: today, minutes: 99, goal_id: timeGoal });
  const theirs = body(await call("get_time", { from: dayFrom(-5), to: today }, intruder));
  assert.deepEqual(theirs.days, []);
  const result = await call("record_time", { day: dayFrom(1), minutes: 10 });
  assert.equal(result.isError, true);
  assert.equal(body(result).key, "day.errors.dayFuture");
});
