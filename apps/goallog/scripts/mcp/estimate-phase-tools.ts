// Proves RP-139 for set_task_estimate and edit_phase: a connected AI changes a
// task's estimate and a phase's aim and dates through the acts the screen runs,
// and meets the screen's own refusals with their key and sentence. Each handler
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

import month from "../../messages/es/month.json";
import plan from "../../messages/es/plan.json";
import roadmap from "../../messages/es/roadmap.json";

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
let acts: {
  plan: typeof import("@/app/actions/plan");
  planEdit: typeof import("@/app/actions/plan-edit");
  oneOffs: typeof import("@/app/actions/one-offs");
};
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

// A goal measured in minutes: the only kind whose tasks carry an estimate (RP-50).
async function measuring(person: Person, name: string, unit: string, horizon: string): Promise<string> {
  return as(person, async () => {
    const made = await acts.plan.createGoal({ name, horizon });
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

// A parent with parts is fixed to a month and holds no estimate of its own (RP-30).
async function planTask(
  person: Person,
  goalId: string,
  name: string,
  estimate: number | null,
  opts: { parentId?: string; plannedMonth?: string } = {},
) {
  const { parentId, plannedMonth } = opts;
  return as(person, async () => {
    const made = await acts.oneOffs.createOneOff({
      name,
      day: null,
      goalId: parentId === undefined ? goalId : undefined,
      parentId,
      estimate: estimate ?? undefined,
      plannedMonth,
      inPlan: parentId === undefined && plannedMonth === undefined ? true : undefined,
    } as never);
    if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
    return made.oneOffId;
  });
}

async function taskRow(id: string) {
  const [row] = await admin<{ name: string; estimate: number | null; planned_month: string | null }[]>`
    select name, estimate, planned_month::text as planned_month from goals.one_offs where id = ${id}`;
  return row;
}

async function phaseRow(id: string) {
  const [row] = await admin<{ aim: string; starts_on: string; ends_on: string }[]>`
    select aim, starts_on::text as starts_on, ends_on::text as ends_on from goals.phases where id = ${id}`;
  return row;
}

async function newPhase(person: Person, goalId: string, aim: string, from: number, to: number): Promise<string> {
  return as(person, async () => {
    const made = await acts.plan.addPhase({ goalId, aim, startsOn: dayFrom(from), endsOn: dayFrom(to) } as never);
    if (!made.ok) throw new Error(`addPhase: ${made.error}`);
    return made.phaseId;
  });
}

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
  acts = { plan: await import("@/app/actions/plan"), planEdit: await import("@/app/actions/plan-edit"), oneOffs: await import("@/app/actions/one-offs") };
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer;
  registerWriteTools(server);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  timeGoal = await measuring(subject, "Inglés", "minutos", dayFrom(120));
  pagesGoal = await measuring(subject, "Libro", "páginas", dayFrom(120));
  intruderGoal = await measuring(intruder, "Ajena", "minutos", dayFrom(120));
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("set_task_estimate writes the estimate and keeps the task's name", async () => {
  const task = await planTask(subject, timeGoal, "Maze", 30);
  await succeeds("set_task_estimate", { one_off_id: task, estimate: 180 });
  const row = await taskRow(task);
  assert.equal(row.estimate, 180);
  assert.equal(row.name, "Maze");
});

test("set_task_estimate with null clears the estimate and leaves the task in the plan", async () => {
  const task = await planTask(subject, timeGoal, "Sin cifra", 45);
  await succeeds("set_task_estimate", { one_off_id: task, estimate: null });
  const row = await taskRow(task);
  assert.equal(row.estimate, null);
  assert.equal(row.name, "Sin cifra");
  const [flags] = await admin<{ in_plan: boolean }[]>`select in_plan from goals.one_offs where id = ${task}`;
  assert.equal(flags.in_plan, true);
});

test("set_task_estimate on a task with sub-tasks is refused with the act's key and sentence, and writes nothing", async () => {
  const parent = await planTask(subject, timeGoal, "Con partes", null, { plannedMonth: today.slice(0, 7) });
  await planTask(subject, timeGoal, "Parte", 20, { parentId: parent });
  await refused(
    "set_task_estimate",
    { one_off_id: parent, estimate: 60 },
    "roadmap.errors.parentEstimate",
    roadmap.errors.parentEstimate,
  );
  assert.equal((await taskRow(parent)).estimate, null);
});

test("set_task_estimate on a goal that measures no time is refused with the act's key and sentence", async () => {
  const task = await as(subject, async () => {
    const made = await acts.oneOffs.createOneOff({ name: "Capítulo", day: null, goalId: pagesGoal, inPlan: false } as never);
    if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
    return made.oneOffId;
  });
  await refused("set_task_estimate", { one_off_id: task, estimate: 60 }, "month.errors.estimateNotTime", month.errors.estimateNotTime);
  assert.equal((await taskRow(task)).estimate, null);
});

test("set_task_estimate with an estimate the screen refuses is refused with its key and sentence", async () => {
  const task = await planTask(subject, timeGoal, "Cero", 30);
  await refused(
    "set_task_estimate",
    { one_off_id: task, estimate: 0 },
    "month.errors.estimateInvalid",
    month.errors.estimateInvalid,
  );
  await refused(
    "set_task_estimate",
    { one_off_id: task, estimate: 1.5 },
    "month.errors.estimateInvalid",
    month.errors.estimateInvalid,
  );
  assert.equal((await taskRow(task)).estimate, 30);
});

test("set_task_estimate on another person's task is refused and writes nothing", async () => {
  const theirs = await planTask(intruder, intruderGoal, "Ajena", 30);
  await refused("set_task_estimate", { one_off_id: theirs, estimate: 999 }, "plan.errors.notFound", plan.errors.notFound);
  assert.equal((await taskRow(theirs)).estimate, 30);
});

test("edit_phase writes the aim and both days", async () => {
  const phase = await newPhase(subject, timeGoal, "Fundamentos", 1, 14);
  await succeeds("edit_phase", { phase_id: phase, aim: "Medir", starts_on: dayFrom(2), ends_on: dayFrom(30) });
  assert.deepEqual(await phaseRow(phase), { aim: "Medir", starts_on: dayFrom(2), ends_on: dayFrom(30) });
});

test("edit_phase with dates past the goal's end is refused with the act's key and sentence, and writes nothing", async () => {
  const phase = await newPhase(subject, pagesGoal, "Dentro", 1, 14);
  await refused(
    "edit_phase",
    { phase_id: phase, aim: "Fuera", starts_on: dayFrom(5), ends_on: dayFrom(400) },
    "plan.errors.phasePastHorizon",
    plan.errors.phasePastHorizon,
  );
  assert.deepEqual(await phaseRow(phase), { aim: "Dentro", starts_on: dayFrom(1), ends_on: dayFrom(14) });
});

test("edit_phase into another phase's days is refused with the act's key, and writes nothing", async () => {
  const goal = await measuring(subject, "Dos fases", "minutos", dayFrom(120));
  await newPhase(subject, goal, "Primera", 1, 14);
  const second = await newPhase(subject, goal, "Segunda", 15, 28);
  await refused(
    "edit_phase",
    { phase_id: second, aim: "Choca", starts_on: dayFrom(10), ends_on: dayFrom(28) },
    "plan.errors.phaseOverlap",
    plan.errors.phaseOverlap,
  );
  assert.equal((await phaseRow(second)).aim, "Segunda");
});

test("edit_phase on another person's phase is refused and writes nothing", async () => {
  const theirs = await newPhase(intruder, intruderGoal, "Ajena", 1, 14);
  await refused(
    "edit_phase",
    { phase_id: theirs, aim: "Mía", starts_on: dayFrom(1), ends_on: dayFrom(14) },
    "plan.errors.phaseNotFound",
    plan.errors.phaseNotFound,
  );
  assert.equal((await phaseRow(theirs)).aim, "Ajena");
});

test("edit_phase with an end before its start is refused with the screen's key", async () => {
  const phase = await newPhase(subject, timeGoal, "Orden", 40, 50);
  const result = await call("edit_phase", { phase_id: phase, aim: "Al revés", starts_on: dayFrom(45), ends_on: dayFrom(41) });
  assert.equal(result.isError, true);
  assert.deepEqual(await phaseRow(phase), { aim: "Orden", starts_on: dayFrom(40), ends_on: dayFrom(50) });
});
