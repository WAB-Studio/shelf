// Proves RP-117 and RP-119 for `set_rhythm` and `set_measure`: each handler,
// called in-process with a stub `ctx` that carries a person the way
// `withMcpAuth` will, writes through the act the screen runs, answers the act's
// refusals with their key and their sentence, and writes nothing when it
// refuses. No tool takes a rhythm away or changes a measure that is set.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { todayInZone } from "@/lib/zone";

import month from "../../messages/es/month.json";
import plan from "../../messages/es/plan.json";
import roadmap from "../../messages/es/roadmap.json";
import tree from "../../messages/es/tree.json";

type Handler = (input: Record<string, unknown>, ctx: ServerContext) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
type Registered = { annotations?: Record<string, unknown>; inputSchema: { safeParse: (value: unknown) => { success: boolean } } };

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

const handlers = new Map<string, Handler>();
const registered = new Map<string, Registered>();
let session: typeof import("@/lib/session");
let acts: { plan: typeof import("@/app/actions/plan"); oneOffs: typeof import("@/app/actions/one-offs") };
let subject: Person;
let intruder: Person;
let foreignGoal: string;

const NEVER = [
  "remove_rhythm",
  "clear_rhythm",
  "change_measure",
  "update_measure",
  "set_goal_measure",
  "set_goal_rhythm",
  "remove_measure",
];

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

function monthFrom(delta: number): string {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

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

async function succeeds(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(name, input);
  assert.notEqual(result.isError, true, `${name} failed: ${result.content[0]?.text}`);
  assert.ok(result.structuredContent, `${name} answered no structuredContent`);
  assert.equal(result.structuredContent.ok, true);
  return result.structuredContent;
}

async function refused(name: string, input: Record<string, unknown>, key: string, sentence: string, person?: Person) {
  const result = await call(name, input, person);
  assert.equal(result.isError, true, `${name} did not refuse`);
  assert.deepEqual(body(result), { key, message: sentence });
  assert.equal(result.structuredContent, undefined);
}

async function goalRow(id: string) {
  const [row] = await admin<{ rhythm: number | null; measure_name: string | null; measure_unit: string | null }[]>`
    select rhythm, measure_name, measure_unit from goals.goals where id = ${id}`;
  return row;
}

// An open goal that measures `unit`, through the first commitment of a quantity (what a person does).
async function measuring(name: string, unit: string, opts: { horizon?: string; parentId?: string } = {}): Promise<string> {
  return as(subject, async () => {
    const made = await acts.plan.createGoal({ name, horizon: opts.horizon ?? dayFrom(200), parentId: opts.parentId } as never);
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

async function bare(name: string): Promise<string> {
  return as(subject, async () => {
    const made = await acts.plan.createGoal({ name, horizon: dayFrom(200) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    return made.goalId;
  });
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  acts = { plan: await import("@/app/actions/plan"), oneOffs: await import("@/app/actions/one-offs") };
  const server = {
    registerTool: (name: string, config: Registered, handler: Handler) => {
      handlers.set(name, handler);
      registered.set(name, config);
    },
  } as unknown as McpServer;
  const { registerReadTools } = await import("@/lib/mcp/tools/read");
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerReadTools(server);
  registerWriteTools(server);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  foreignGoal = await as(intruder, async () => {
    const made = await acts.plan.createGoal({ name: "ajena", horizon: dayFrom(200) });
    if (!made.ok) throw new Error(`createGoal intruder: ${made.error}`);
    const commitment = await acts.plan.addCommitment({
      goalId: made.goalId, name: "ajeno", cadenceKind: "daily", satisfaction: "quantity", targetQuantity: 5, unit: "páginas",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment intruder: ${commitment.error}`);
    return made.goalId;
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

test("tools/list carries set_rhythm and set_measure as writes that never destroy, eighteen writes in all", () => {
  const writes = [...registered.entries()].filter(([, config]) => config.annotations?.readOnlyHint === false);
  assert.equal(writes.length, 18);
  assert.equal(registered.size, 24);
  for (const name of ["set_rhythm", "set_measure"]) {
    assert.deepEqual(registered.get(name)?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, name);
  }
});

test("no tool takes a rhythm away or changes a measure that is set (RP-119)", () => {
  for (const name of NEVER) assert.equal(handlers.has(name), false, `${name} must not exist`);
  assert.deepEqual([...handlers.keys()].filter((name) => /rhythm|ritmo/.test(name)), ["set_rhythm"]);
  const schema = registered.get("set_rhythm")!.inputSchema;
  assert.equal(schema.safeParse({ goal_id: "g", amount: null }).success, false);
  assert.equal(schema.safeParse({ goal_id: "g" }).success, false);
});

test("set_rhythm gives «Leer» its rhythm and get_goal reads it back (R1)", async () => {
  const id = await measuring("Leer", "páginas");
  assert.equal((await goalRow(id)).rhythm, null);
  await succeeds("set_rhythm", { goal_id: id, amount: 40 });
  assert.equal((await goalRow(id)).rhythm, 40);
  const read = (await call("get_goal", { goal_id: id })).structuredContent as { rhythm: { value: number; unit: string } };
  assert.equal(read.rhythm.value, 40);
  assert.equal(read.rhythm.unit, "páginas");
});

test("set_rhythm changes a rhythm that is set: 40 then 55", async () => {
  const id = await measuring("Leer más", "páginas");
  await succeeds("set_rhythm", { goal_id: id, amount: 40 });
  await succeeds("set_rhythm", { goal_id: id, amount: 55 });
  assert.equal((await goalRow(id)).rhythm, 55);
});

test("a changed rhythm keeps each closed month's own amount, as on screen (RP-74)", async () => {
  const id = await measuring("Meses cerrados", "páginas");
  await admin`update goals.goals set created_at = now() - interval '70 days' where id = ${id}`;
  await succeeds("set_rhythm", { goal_id: id, amount: 40 });
  const before = await admin`select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets where goal_id = ${id} order by month`;
  await succeeds("set_rhythm", { goal_id: id, amount: 55 });
  const after = await admin`select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets where goal_id = ${id} order by month`;
  for (const row of before) assert.equal(after.find((other) => other.month === row.month)?.amount, row.amount, row.month);
});

test("the first rhythm of a goal in minutes sends its fixed pending tasks back to the plan (RP-50)", async () => {
  const id = await measuring("Estudiar fijo", "minutos");
  const fixed: string[] = [];
  for (const name of ["fija uno", "fija dos"]) {
    const made = await as(subject, () =>
      acts.oneOffs.createOneOff({ name, day: null, goalId: id, estimate: 30, plannedMonth: monthFrom(1) }),
    );
    if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
    fixed.push(made.oneOffId);
  }
  const held = await admin`select planned_month from goals.one_offs where id = any(${fixed}::uuid[])`;
  assert.ok(held.every((row) => row.planned_month !== null), "the tasks start fixed");
  await succeeds("set_rhythm", { goal_id: id, amount: 600 });
  const freed = await admin`select planned_month from goals.one_offs where id = any(${fixed}::uuid[])`;
  assert.ok(freed.every((row) => row.planned_month === null));
});

test("set_rhythm refuses with the act's key and sentence, and writes nothing", async () => {
  const holder = await bare("Contenedora");
  await as(subject, async () => {
    const child = await acts.plan.createGoal({ name: "Dentro", horizon: dayFrom(100), parentId: holder } as never);
    if (!child.ok) throw new Error(`createGoal child: ${child.error}`);
  });
  await refused("set_rhythm", { goal_id: holder, amount: 40 }, "tree.errors.holderNoRhythm", tree.errors.holderNoRhythm);
  assert.equal((await goalRow(holder)).rhythm, null);

  const closed = await measuring("Archivada", "páginas");
  await admin`update goals.goals set archived_at = now() where id = ${closed}`;
  await refused("set_rhythm", { goal_id: closed, amount: 40 }, "month.errors.closed", month.errors.closed);
  assert.equal((await goalRow(closed)).rhythm, null);

  const unmeasured = await bare("Sin medida");
  await refused("set_rhythm", { goal_id: unmeasured, amount: 40 }, "roadmap.errors.rhythmNoMeasure", roadmap.errors.rhythmNoMeasure);
  assert.equal((await goalRow(unmeasured)).rhythm, null);

  const timed = await measuring("En minutos", "minutos");
  for (const amount of [0, 50_000]) {
    await refused("set_rhythm", { goal_id: timed, amount }, "roadmap.errors.rhythmRange", roadmap.errors.rhythmRange);
  }
  assert.equal((await goalRow(timed)).rhythm, null);

  const before = await goalRow(foreignGoal);
  await refused("set_rhythm", { goal_id: foreignGoal, amount: 40 }, "month.errors.notFound", month.errors.notFound);
  assert.deepEqual(await goalRow(foreignGoal), before);
});

test("set_measure gives «Mudanza» its measure and get_goal says its unit (R2)", async () => {
  const id = await bare("Mudanza");
  await succeeds("set_measure", { goal_id: id, name: "Cajas embaladas", unit: "cajas" });
  assert.deepEqual(await goalRow(id), { rhythm: null, measure_name: "Cajas embaladas", measure_unit: "cajas" });
  const read = await call("get_goal", { goal_id: id });
  assert.ok(JSON.stringify(read.structuredContent).includes("cajas"));
});

test("set_measure in hours is stored in minutes (RP-66)", async () => {
  const id = await bare("Estudio");
  await succeeds("set_measure", { goal_id: id, name: "Tiempo", unit: "horas" });
  assert.equal((await goalRow(id)).measure_unit, "minutos");
});

test("set_measure refuses with the act's key and sentence, and writes nothing", async () => {
  const kept = await measuring("Ya mide", "páginas");
  const was = await goalRow(kept);
  await refused("set_measure", { goal_id: kept, name: "Km", unit: "km" }, "plan.errors.measureKept", plan.errors.measureKept.replace("{name}", "páginas"));
  assert.deepEqual(await goalRow(kept), was);

  const holder = await bare("Contenedora de medida");
  await as(subject, async () => {
    const child = await acts.plan.createGoal({ name: "Dentro de medida", horizon: dayFrom(100), parentId: holder } as never);
    if (!child.ok) throw new Error(`createGoal child: ${child.error}`);
  });
  // A child inherits no measure from a bare holder, so the holder is the refusal.
  await refused("set_measure", { goal_id: holder, name: "Algo", unit: "cosas" }, "plan.errors.holderNoMeasure", plan.errors.holderNoMeasure);
  assert.equal((await goalRow(holder)).measure_name, null);

  const closed = await bare("Cerrada de medida");
  await admin`update goals.goals set archived_at = now() where id = ${closed}`;
  await refused("set_measure", { goal_id: closed, name: "Algo", unit: "cosas" }, "plan.errors.goalNotFound", plan.errors.goalNotFound);
  assert.equal((await goalRow(closed)).measure_name, null);

  const before = await goalRow(foreignGoal);
  await refused("set_measure", { goal_id: foreignGoal, name: "Algo", unit: "cosas" }, "plan.errors.notFound", plan.errors.notFound);
  assert.deepEqual(await goalRow(foreignGoal), before);
});
