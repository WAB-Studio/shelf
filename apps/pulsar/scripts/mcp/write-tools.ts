// Proves RP-56, RP-51, RNP-05 and RNP-14 for the write tools: each handler,
// called in-process with a stub `ctx` that carries a person the way
// `withMcpAuth` will, runs the act the app runs, writes under the subject,
// writes nothing for the intruder's target, and issues exactly the
// statements the act issues called directly. Statements come off the wire as
// `read-tools.ts` counts them. Rows read back through `DATABASE_URL`'s
// pooler; the intruder's rows are fingerprinted through the admin door.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import { todayInZone } from "@/lib/zone";

import day from "../../messages/es/day.json";
import month from "../../messages/es/month.json";
import plan from "../../messages/es/plan.json";
import roadmap from "../../messages/es/roadmap.json";

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
let acts: {
  plan: typeof import("@/app/actions/plan");
  budgets: typeof import("@/app/actions/budgets");
  oneOffs: typeof import("@/app/actions/one-offs");
  facts: typeof import("@/app/actions/facts");
};
let subject: Person;
let intruder: Person;
let goal: string;
let quantityCommitment: string;
let quantityGoal: string;
let intruderGoal: string;
let intruderCommitment: string;
let intruderTask: string;
let intruderLoose: string;

const NEVER = [
  "accept_shift",
  "move_task_to_month",
  "delete_one_off",
  "undo_fact",
  "remove_month_amount",
  "remove_month_budget",
  "archive_goal",
  "reopen_goal",
  "confirm_import",
  "create_access_token",
  "revoke_access_token",
  "approve_authorization",
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

function dayFrom(delta: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function monthFrom(delta: number): string {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const currentMonth = monthFrom(0);
const nextMonth = monthFrom(1);
const previousMonth = monthFrom(-1);

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
  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(body(result), result.structuredContent);
  return result.structuredContent;
}

async function refused(name: string, input: Record<string, unknown>, key: string, sentence: string, person?: Person) {
  const result = await call(name, input, person);
  assert.equal(result.isError, true, `${name} did not refuse`);
  assert.deepEqual(body(result), { key, message: sentence });
  assert.equal(result.structuredContent, undefined);
}

// Every row of the intruder, as one string: a write that touches any of it changes the digest.
async function fingerprint(): Promise<string> {
  const tables = ["goals", "commitments", "phases", "one_offs", "facts", "month_budgets"];
  const parts: string[] = [];
  for (const table of tables) {
    const [row] = await admin.unsafe(
      `select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as digest, count(*)::int as n
         from goals.${table} t where t.user_id = $1`,
      [intruder.id],
    );
    parts.push(`${table}:${row.n}:${row.digest}`);
  }
  return parts.join(" ");
}

async function freshTask(): Promise<string> {
  const made = await as(subject, () => acts.oneOffs.createOneOff({ name: "fresca", day: null }));
  if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
  return made.oneOffId;
}

async function freshGoal(): Promise<string> {
  const made = await as(subject, () => acts.plan.createGoal({ name: "otra", horizon: dayFrom(120) }));
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  return made.goalId;
}

async function freshCommitment(): Promise<string> {
  const made = await as(subject, () =>
    acts.plan.addCommitment({
      goalId: goal,
      name: `compromiso ${Math.random()}`,
      cadenceKind: "daily",
      satisfaction: "tap",
    } as never),
  );
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  return made.commitmentId;
}

// A task of the goal's plan with no month of its own: the plan places it (RP-50).
async function freshPlanTask(): Promise<string> {
  const made = await as(subject, () =>
    acts.oneOffs.createOneOff({ name: "del plan", day: null, goalId: goal, estimate: 30, inPlan: true }),
  );
  if (!made.ok) throw new Error(`createOneOff plan: ${made.error}`);
  return made.oneOffId;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  acts = {
    plan: await import("@/app/actions/plan"),
    budgets: await import("@/app/actions/budgets"),
    oneOffs: await import("@/app/actions/one-offs"),
    facts: await import("@/app/actions/facts"),
  };
  const { registerWriteTools } = await import("@/lib/mcp/tools/write");
  registerWriteTools({
    registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler),
  } as unknown as McpServer);

  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);

  await as(subject, async () => {
    const made = await acts.plan.createGoal({ name: "escribir tools", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    goal = made.goalId;
    // Its own goal: opening it 20 days back must not move `goal`'s span.
    const old = await acts.plan.createGoal({ name: "estudiar de antes", horizon: dayFrom(120) });
    if (!old.ok) throw new Error(`createGoal old: ${old.error}`);
    quantityGoal = old.goalId;
    const commitment = await acts.plan.addCommitment({
      goalId: quantityGoal,
      name: "estudiar",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    quantityCommitment = commitment.commitmentId;
  });
  // A past day is only open to a commitment that already existed that day.
  await admin`update goals.commitments set created_at = now() - interval '20 days' where id = ${quantityCommitment}`;
  await admin`update goals.goals set created_at = now() - interval '20 days' where id = ${quantityGoal}`;

  await as(intruder, async () => {
    const made = await acts.plan.createGoal({ name: "ajena", horizon: dayFrom(120) });
    if (!made.ok) throw new Error(`createGoal intruder: ${made.error}`);
    intruderGoal = made.goalId;
    const commitment = await acts.plan.addCommitment({
      goalId: intruderGoal,
      name: "ajeno",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 10,
      unit: "minutos",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment intruder: ${commitment.error}`);
    intruderCommitment = commitment.commitmentId;
    const phase = await acts.plan.addPhase({
      goalId: intruderGoal,
      aim: "fase ajena",
      startsOn: dayFrom(1),
      endsOn: dayFrom(20),
    });
    if (!phase.ok) throw new Error(`addPhase intruder: ${phase.error}`);
    const task = await acts.oneOffs.createOneOff({
      name: "tarea ajena",
      day: null,
      goalId: intruderGoal,
      estimate: 10,
      plannedMonth: currentMonth,
    });
    if (!task.ok) throw new Error(`createOneOff intruder: ${task.error}`);
    intruderTask = task.oneOffId;
    const loose = await acts.oneOffs.createOneOff({ name: "suelta ajena", day: null });
    if (!loose.ok) throw new Error(`createOneOff intruder loose: ${loose.error}`);
    intruderLoose = loose.oneOffId;
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

test("exactly the sixteen write tools are registered, and none of the never-registered", () => {
  assert.deepEqual([...handlers.keys()].sort(), [
    "add_commitment",
    "add_phase",
    "complete_task",
    "create_goal",
    "create_task",
    "declare_fact",
    "fix_task",
    "move_goal",
    "move_horizon",
    "rename_goal",
    "retire_commitment",
    "schedule_task",
    "set_goal_note",
    "set_month_amount",
    "set_task_note",
    "unfix_task",
  ]);
  for (const name of NEVER) assert.equal(handlers.has(name), false, `${name} must not exist`);
});

test("create_goal writes a goal that reads back by its returned id", async () => {
  const result = await succeeds("create_goal", { name: "  nueva  ", horizon: dayFrom(90) });
  const [row] = await door`select name, horizon::text as horizon, user_id from goals.goals where id = ${result.goalId as string}`;
  assert.equal(row.name, "nueva");
  assert.equal(row.horizon, dayFrom(90));
  assert.equal(row.user_id, subject.id);
});

test("an empty name is refused with the act's key and sentence, and nothing is written", async () => {
  const before = (await door`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n;
  await refused("create_goal", { name: "   ", horizon: dayFrom(90) }, "plan.errors.nameEmpty", plan.errors.nameEmpty);
  await refused("rename_goal", { goal_id: goal, name: " " }, "plan.errors.nameEmpty", plan.errors.nameEmpty);
  const after = (await door`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n;
  assert.equal(after, before);
  const [row] = await door`select name from goals.goals where id = ${goal}`;
  assert.equal(row.name, "escribir tools");
});

test("rename_goal and move_horizon write to the subject's goal", async () => {
  const id = await freshGoal();
  await succeeds("rename_goal", { goal_id: id, name: "renombrada" });
  await succeeds("move_horizon", { goal_id: id, horizon: dayFrom(150) });
  const [row] = await door`select name, horizon::text as horizon from goals.goals where id = ${id}`;
  assert.equal(row.name, "renombrada");
  assert.equal(row.horizon, dayFrom(150));
});

test("add_phase and add_commitment write rows that read back, and a phase may not overlap another", async () => {
  const phase = await succeeds("add_phase", { goal_id: goal, aim: "empezar", starts_on: dayFrom(1), ends_on: dayFrom(14) });
  const [phaseRow] = await door`select aim, goal_id from goals.phases where id = ${phase.phaseId as string}`;
  assert.deepEqual([phaseRow.aim, phaseRow.goal_id], ["empezar", goal]);

  const overlap = await call("add_phase", { goal_id: goal, aim: "choca", starts_on: dayFrom(5), ends_on: dayFrom(20) });
  assert.equal(overlap.isError, true);
  assert.equal(body(overlap).key, "plan.errors.phaseOverlap");

  const commitment = await succeeds("add_commitment", {
    goal_id: goal,
    name: "caminar",
    cadence_kind: "weekdays",
    cadence_weekdays: [1, 3, 5],
    satisfaction: "quantity",
    target_quantity: 20,
    unit: "minutos",
  });
  const [row] = await door`select name, cadence_kind, satisfaction, target_quantity from goals.commitments where id = ${commitment.commitmentId as string}`;
  assert.deepEqual(
    [row.name, row.cadence_kind, row.satisfaction, row.target_quantity],
    ["caminar", "weekdays", "quantity", 20],
  );
});

test("retire_commitment retires the subject's commitment and the facts it has stand", async () => {
  const id = await freshCommitment();
  await succeeds("retire_commitment", { commitment_id: id });
  const [row] = await door`select retired_at from goals.commitments where id = ${id}`;
  assert.notEqual(row.retired_at, null);
});

test("create_task writes a loose task, a month task and a sub-task, each reading back", async () => {
  const loose = await succeeds("create_task", { name: "suelta" });
  const [looseRow] = await door`select name, day, goal_id from goals.one_offs where id = ${loose.oneOffId as string}`;
  assert.deepEqual([looseRow.name, looseRow.day, looseRow.goal_id], ["suelta", null, null]);

  const measured = await succeeds("create_task", { name: "mensual", goal_id: goal, estimate: 90, planned_month: currentMonth });
  const [measuredRow] = await door`select estimate, planned_month::text as planned_month from goals.one_offs where id = ${measured.oneOffId as string}`;
  assert.deepEqual([measuredRow.estimate, measuredRow.planned_month], [90, `${currentMonth}-01`]);

  // A parent owes through its children, so it carries no time of its own.
  const task = await succeeds("create_task", { name: "con pasos", goal_id: goal, planned_month: currentMonth });

  const child = await succeeds("create_task", { name: "paso", parent_id: task.oneOffId, estimate: 30 });
  const [childRow] = await door`select parent_id, estimate from goals.one_offs where id = ${child.oneOffId as string}`;
  assert.deepEqual([childRow.parent_id, childRow.estimate], [task.oneOffId, 30]);

  await refused("create_task", { name: "" }, "day.errors.oneOffNameEmpty", day.errors.oneOffNameEmpty);
});

test("schedule_task gives a loose task a day, and a day in the past is refused", async () => {
  const id = await freshTask();
  await refused("schedule_task", { one_off_id: id, day: dayFrom(-1) }, "day.errors.oneOffDayPast", day.errors.oneOffDayPast);
  await succeeds("schedule_task", { one_off_id: id, day: dayFrom(3) });
  const [row] = await door`select day::text as day from goals.one_offs where id = ${id}`;
  assert.equal(row.day, dayFrom(3));
});

test("complete_task writes the fact of a task, once", async () => {
  const id = await freshTask();
  const result = await succeeds("complete_task", { one_off_id: id });
  const [row] = await door`select one_off_id, day::text as day from goals.facts where id = ${result.factId as string}`;
  assert.deepEqual([row.one_off_id, row.day], [id, today]);
});

test("declare_fact writes a commitment's quantity on a past day within the bound, and refuses one beyond it", async () => {
  const past = dayFrom(-2);
  const result = await succeeds("declare_fact", { commitment_id: quantityCommitment, quantity: 25, day: past });
  const [row] = await door`select quantity, day::text as day, commitment_id from goals.facts where id = ${result.factId as string}`;
  assert.deepEqual([row.quantity, row.day, row.commitment_id], [25, past, quantityCommitment]);

  const count = async () => (await door`select count(*)::int as n from goals.facts where commitment_id = ${quantityCommitment}`)[0].n;
  const before = await count();
  await refused("declare_fact", { commitment_id: quantityCommitment, quantity: 25, day: dayFrom(-30) }, "day.errors.dayTooOld", day.errors.dayTooOld);
  await refused("declare_fact", { commitment_id: quantityCommitment, day: dayFrom(-3) }, "day.errors.quantityRequired", day.errors.quantityRequired);
  assert.equal(await count(), before);
});

test("set_month_amount writes an open month and refuses a closed one without writing", async () => {
  await succeeds("set_month_amount", { goal_id: goal, month: nextMonth, amount: 400 });
  const [row] = await door`select amount from goals.month_budgets where goal_id = ${goal} and month = ${`${nextMonth}-01`}`;
  assert.equal(row.amount, 400);

  await refused("set_month_amount", { goal_id: goal, month: previousMonth, amount: 400 }, "month.errors.monthClosed", month.errors.monthClosed);
  const rows = await door`select 1 from goals.month_budgets where goal_id = ${goal} and month = ${`${previousMonth}-01`}`;
  assert.equal(rows.length, 0);
});

test("fix_task fixes a plan task to a month and unfix_task returns it to the plan", async () => {
  const id = await freshPlanTask();
  await succeeds("fix_task", { one_off_id: id, month: nextMonth });
  const [fixed] = await door`select planned_month::text as planned_month, in_plan from goals.one_offs where id = ${id}`;
  assert.deepEqual([fixed.planned_month, fixed.in_plan], [`${nextMonth}-01`, true]);

  await succeeds("unfix_task", { one_off_id: id });
  const [back] = await door`select planned_month::text as planned_month, in_plan from goals.one_offs where id = ${id}`;
  assert.deepEqual([back.planned_month, back.in_plan], [null, true]);
});

test("create_task with in_plan writes a task the plan places, with no month of its own", async () => {
  const made = await succeeds("create_task", { name: "para el plan", goal_id: goal, estimate: 45, in_plan: true });
  const [row] = await door`select in_plan, planned_month from goals.one_offs where id = ${made.oneOffId as string}`;
  assert.deepEqual([row.in_plan, row.planned_month], [true, null]);
});

test("a done task is refused fixing and unfixing with the act's Spanish reason, and keeps its month", async () => {
  const id = await freshPlanTask();
  await succeeds("fix_task", { one_off_id: id, month: currentMonth });
  await succeeds("complete_task", { one_off_id: id });
  await refused("fix_task", { one_off_id: id, month: nextMonth }, "roadmap.errors.doneTask", roadmap.errors.doneTask);
  await refused("unfix_task", { one_off_id: id }, "roadmap.errors.doneTask", roadmap.errors.doneTask);
  const [row] = await door`select planned_month::text as planned_month from goals.one_offs where id = ${id}`;
  assert.equal(row.planned_month, `${currentMonth}-01`);
});

test("fix_task refuses a month before the goal opened and one past its end, and writes nothing", async () => {
  const id = await freshPlanTask();
  await refused("fix_task", { one_off_id: id, month: monthFrom(-1) }, "roadmap.errors.monthOutsideSpan", roadmap.errors.monthOutsideSpan);
  await refused("fix_task", { one_off_id: id, month: monthFrom(24) }, "roadmap.errors.monthOutsideSpan", roadmap.errors.monthOutsideSpan);
  const [row] = await door`select planned_month from goals.one_offs where id = ${id}`;
  assert.equal(row.planned_month, null);
});

test("the intruder's fingerprint sees its facts: adding one moves the digest, removing it puts it back", async () => {
  const before = await fingerprint();
  const [fact] = await admin`
    insert into goals.facts (user_id, one_off_id, day) values (${intruder.id}, ${intruderLoose}, current_date) returning id`;
  try {
    assert.notEqual(await fingerprint(), before, "a new fact of the intruder left the digest where it was");
  } finally {
    await admin`delete from goals.facts where id = ${fact.id}`;
  }
  assert.equal(await fingerprint(), before);
});

test("every tool on the intruder's target answers the act's not-found key and writes nothing", async () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["declare_fact", { commitment_id: intruderCommitment, quantity: 5 }, "day.errors.notFound", day.errors.notFound],
    ["complete_task", { one_off_id: intruderLoose }, "day.errors.notFound", day.errors.notFound],
    ["create_task", { name: "x", goal_id: intruderGoal, estimate: 5, planned_month: currentMonth }, "plan.errors.goalNotFound", plan.errors.goalNotFound],
    ["create_task", { name: "x", parent_id: intruderTask, estimate: 5 }, "month.errors.notFound", month.errors.notFound],
    ["schedule_task", { one_off_id: intruderLoose, day: dayFrom(2) }, "day.errors.notFound", day.errors.notFound],
    ["set_month_amount", { goal_id: intruderGoal, month: nextMonth, amount: 5 }, "month.errors.notFound", month.errors.notFound],
    ["rename_goal", { goal_id: intruderGoal, name: "mía" }, "plan.errors.notFound", plan.errors.notFound],
    ["add_phase", { goal_id: intruderGoal, aim: "x", starts_on: dayFrom(40), ends_on: dayFrom(50) }, "plan.errors.goalNotFound", plan.errors.goalNotFound],
    ["add_commitment", { goal_id: intruderGoal, name: "x", cadence_kind: "daily", satisfaction: "tap" }, "plan.errors.goalNotFound", plan.errors.goalNotFound],
    ["move_horizon", { goal_id: intruderGoal, horizon: dayFrom(200) }, "plan.errors.notFound", plan.errors.notFound],
    ["fix_task", { one_off_id: intruderTask, month: nextMonth }, "plan.errors.notFound", plan.errors.notFound],
    ["unfix_task", { one_off_id: intruderTask }, "plan.errors.notFound", plan.errors.notFound],
    ["retire_commitment", { commitment_id: intruderCommitment }, "plan.errors.notFound", plan.errors.notFound],
  ];
  const before = await fingerprint();
  for (const [name, input, key, sentence] of cases) {
    await refused(name, input, key, sentence);
    assert.equal(await fingerprint(), before, `${name} touched the intruder's rows`);
  }
  assert.equal(
    new Set(cases.map(([name]) => name)).size,
    12,
    "every write tool with a target is driven against the intruder",
  );
});

test("create_goal, which has no target, is covered by the intruder only through its own rows", async () => {
  const before = await fingerprint();
  await succeeds("create_goal", { name: "otra mía", horizon: dayFrom(60) });
  assert.equal(await fingerprint(), before);
});

test("a call without a person in the context is refused as unauthorized and writes nothing", async () => {
  const before = (await admin`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n;
  const wired = wire.length;
  const result = await handlers.get("create_goal")!(
    { name: "no", horizon: dayFrom(60) },
    { http: { authInfo: { extra: {} } } } as unknown as ServerContext,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result).key, "mcp.errors.unauthorized");
  assert.equal(wire.length, wired);
  assert.equal((await admin`select count(*)::int as n from goals.goals where user_id = ${subject.id}`)[0].n, before);
});

test("each tool issues exactly the statements its act issues called directly", async () => {
  type Case = {
    tool: string;
    make: () => Promise<Record<string, unknown>>;
    direct: (input: Record<string, unknown>) => Promise<unknown>;
  };
  let factDays = 0; // a fresh day per call: a second write on one day is a replace, a different statement
  const cases: Case[] = [
    {
      tool: "create_goal",
      make: async () => ({ name: "contada", horizon: dayFrom(60) }),
      direct: (i) => acts.plan.createGoal(i as never),
    },
    {
      tool: "rename_goal",
      make: async () => ({ goal_id: await freshGoal(), name: "contada" }),
      direct: (i) => acts.plan.renameGoal(i as never),
    },
    {
      tool: "move_horizon",
      make: async () => ({ goal_id: await freshGoal(), horizon: dayFrom(150) }),
      direct: (i) => acts.plan.moveHorizon(i as never),
    },
    {
      tool: "add_phase",
      make: async () => ({ goal_id: await freshGoal(), aim: "contada", starts_on: dayFrom(1), ends_on: dayFrom(9) }),
      direct: (i) => acts.plan.addPhase(i as never),
    },
    {
      tool: "add_commitment",
      make: async () => ({ goal_id: await freshGoal(), name: "contado", cadence_kind: "daily", satisfaction: "tap" }),
      direct: (i) => acts.plan.addCommitment(i as never),
    },
    {
      tool: "retire_commitment",
      make: async () => ({ commitment_id: await freshCommitment() }),
      direct: (i) => acts.plan.retireCommitment(i as never),
    },
    {
      tool: "create_task",
      make: async () => ({ name: "contada", goal_id: goal, estimate: 15, planned_month: currentMonth }),
      direct: (i) => acts.oneOffs.createOneOff({ day: null, ...i } as never),
    },
    {
      tool: "schedule_task",
      make: async () => ({ one_off_id: await freshTask(), day: dayFrom(4) }),
      direct: (i) => acts.oneOffs.scheduleOneOff(i as never),
    },
    {
      tool: "complete_task",
      make: async () => ({ one_off_id: await freshTask() }),
      direct: (i) => acts.oneOffs.completeOneOff(i as never),
    },
    {
      tool: "fix_task",
      make: async () => ({ one_off_id: await freshPlanTask(), month: nextMonth }),
      direct: (i) => acts.oneOffs.fixTask(i as never),
    },
    {
      tool: "unfix_task",
      make: async () => ({ one_off_id: await freshPlanTask() }),
      direct: (i) => acts.oneOffs.fixTask({ ...i, month: null } as never),
    },
    {
      tool: "set_month_amount",
      make: async () => ({ goal_id: goal, month: nextMonth, amount: 111 }),
      direct: (i) => acts.budgets.setMonthBudget(i as never),
    },
    {
      tool: "declare_fact",
      make: async () => ({ commitment_id: quantityCommitment, quantity: 7, day: dayFrom(-4 - factDays++) }),
      direct: (i) => acts.facts.declareFact(i as never),
    },
  ];
  const camel = (input: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(input).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

  const counts: Record<string, [number, number]> = {};
  for (const { tool, make, direct } of cases) {
    const forAct = await make();
    let mark = wire.length;
    const act = (await as(subject, () => direct(camel(forAct)))) as { ok: boolean; error?: string };
    assert.equal(act.ok, true, `${tool} direct: ${act.error}`);
    const actual = statements(wire.slice(mark));

    const forTool = await make();
    mark = wire.length;
    const result = await call(tool, forTool);
    assert.notEqual(result.isError, true, `${tool} failed: ${result.content[0]?.text}`);
    const viaTool = statements(wire.slice(mark));

    counts[tool] = [actual, viaTool];
    assert.equal(viaTool, actual, `${tool}: ${viaTool} statements through the tool, ${actual} through the act`);
    assert.ok(actual > 0, `${tool} measured nothing`);
  }
  console.log(`wire (act, tool): ${JSON.stringify(counts)}`);
});

test("declare_fact refuses a day before the goal opened with the goal's own sentence, and writes nothing", async () => {
  const opened = await freshGoal();
  const made = await as(subject, () =>
    acts.plan.addCommitment({ goalId: opened, name: "hoy", cadenceKind: "daily", satisfaction: "tap" } as never),
  );
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  await refused("declare_fact", { commitment_id: made.commitmentId, day: dayFrom(-1) }, "day.errors.dayBeforeGoal", day.errors.dayBeforeGoal);
  const rows = await door`select 1 from goals.facts where commitment_id = ${made.commitmentId}`;
  assert.equal(rows.length, 0);
});

test("create_task in a goal measured in km with no month pins the task to the current month (RP-62)", async () => {
  const opened = await freshGoal();
  const made = await as(subject, () =>
    acts.plan.addCommitment({
      goalId: opened,
      name: "correr",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 5,
      unit: "km",
    } as never),
  );
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const task = await succeeds("create_task", { name: "carrera larga", goal_id: opened });
  const [row] = await door`select planned_month::text as planned_month from goals.one_offs where id = ${task.oneOffId as string}`;
  assert.equal(row.planned_month, `${currentMonth}-01`);
});

test("move_horizon before a goal inside is refused with that goal's name and its last day in the sentence (RP-56)", async () => {
  const above = await freshGoal();
  const inside = await as(subject, () => acts.plan.createGoal({ name: "la de dentro", horizon: dayFrom(100), parentId: above }));
  if (!inside.ok) throw new Error(`createGoal inside: ${inside.error}`);
  const last = new Date(`${dayFrom(100)}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  const label = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", timeZone: "UTC" }).formatToParts(last);
  const part = (type: string) => label.find((p) => p.type === type)!.value;
  const sentence = `«la de dentro» termina el ${part("day")} ${part("month").slice(0, 3)} ${last.getUTCFullYear()}, después de ese día. Mueve primero su final.`;
  await refused("move_horizon", { goal_id: above, horizon: dayFrom(90) }, "tree.errors.belowEndsLater", sentence);
  const [row] = await door`select horizon::text as horizon from goals.goals where id = ${above}`;
  assert.equal(row.horizon, dayFrom(120));
});
