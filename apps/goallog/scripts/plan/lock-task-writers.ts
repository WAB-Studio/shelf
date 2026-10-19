// M8: a task and its sub-tasks under one lock (concurrencia GoalLog 5, 6), one
// transaction to complete a task, and a stale «Anotar» that says what is kept
// (GoalLog 9). Every race is two real transactions on the database: the first
// is held just before its commit (`lib/hold.ts`) while the second runs, and
// the rows both leave behind are read back as the owner. The acts run as a
// person through `actAs`; the admin pool only reads and cleans up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { createTranslator } from "next-intl";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import { heldDoor, interleave } from "./lib/hold";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = heldDoor(process.env.DATABASE_URL!);
(globalThis as unknown as { sql: unknown }).sql = door.sql;

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

let session: typeof import("@/lib/session");
let facts: typeof import("@/app/actions/facts");
let oneOffs: typeof import("@/app/actions/one-offs");
let plan: typeof import("@/app/actions/plan");
let owner: Person;
let today: string;
let tomorrow: string;
let thisMonth: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(fn: () => Promise<T>) => session.actAs(asResolved(owner), fn);

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function measuredGoal(label: string): Promise<string> {
  const made = await as(() => plan.createGoal({ name: `M8 ${label}`, horizon: shiftDay(today, 200) }));
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  await admin`update goals.goals set measure_name = 'horas', measure_unit = 'minutos' where id = ${made.goalId}`;
  return made.goalId;
}

// A task of a goal's month with nothing under it yet: it may take a sub-task, an estimate or a fact.
async function monthTask(label: string): Promise<string> {
  const goalId = await measuredGoal(label);
  const made = await as(() =>
    oneOffs.createOneOff({ name: `M8 ${label}`, day: null, goalId, plannedMonth: thisMonth }),
  );
  if (!made.ok) throw new Error(`createOneOff task: ${made.error}`);
  return made.oneOffId;
}

async function looseToday(label: string): Promise<string> {
  const made = await as(() => oneOffs.createOneOff({ name: `M8 ${label}`, day: today }));
  if (!made.ok) throw new Error(`createOneOff loose: ${made.error}`);
  return made.oneOffId;
}

async function stateOf(taskId: string) {
  const [row] = await admin<{ day: string | null; estimate: number | null; children: number; fact_days: string[] }[]>`
    select o.day::text as day, o.estimate,
           (select count(*)::int from goals.one_offs c where c.parent_id = o.id) as children,
           coalesce((select array_agg(f.day::text) from goals.facts f where f.one_off_id = o.id), '{}') as fact_days
    from goals.one_offs o where o.id = ${taskId}`;
  return row;
}

const addChild = (parentId: string) => () =>
  as(() => oneOffs.createOneOff({ name: "M8 sub-tarea", day: null, parentId }));

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  facts = await import("@/app/actions/facts");
  oneOffs = await import("@/app/actions/one-offs");
  plan = await import("@/app/actions/plan");
  today = (await import("@/lib/zone")).todayInZone();
  tomorrow = shiftDay(today, 1);
  thisMonth = today.slice(0, 7);
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door.sql, 1);
});

after(async () => {
  try {
    if (owner) {
      await admin`delete from goals.facts where user_id = ${owner.id}`;
      await admin`delete from goals.one_offs where user_id = ${owner.id} and parent_id is not null`;
      await admin`delete from goals.one_offs where user_id = ${owner.id}`;
      await admin`delete from goals.commitments where user_id = ${owner.id}`;
      await admin`delete from goals.goals where user_id = ${owner.id}`;
    }
    await dropPeople(admin);
  } finally {
    await door.sql.end();
    await admin.end();
  }
});

// GoalLog 5. The person ticks the task; its fact waits to commit while the AI adds a sub-task under it.
test("5: a sub-task added while the task is being completed never leaves a done task with a sub-task", async () => {
  const taskId = await monthTask("hecha mientras");
  const raced = await interleave(door, admin, () => as(() => oneOffs.completeOneOff({ oneOffId: taskId })), addChild(taskId));
  assert.equal(raced.first.error, undefined, "completeOneOff threw");
  const state = await stateOf(taskId);
  assert.ok(
    !(state.fact_days.length > 0 && state.children > 0),
    `done (${state.fact_days.length} fact) with ${state.children} sub-task; the sub-task waited on the task: ${raced.secondWaited}`,
  );
});

// GoalLog 5 the other way: the sub-task waits to commit while the person ticks the task.
test("5: a task completed while a sub-task is being added under it is never both done and a parent", async () => {
  const taskId = await monthTask("padre mientras");
  const raced = await interleave(door, admin, addChild(taskId), () => as(() => oneOffs.completeOneOff({ oneOffId: taskId })));
  assert.equal(raced.first.error, undefined, "createOneOff threw");
  const state = await stateOf(taskId);
  assert.ok(
    !(state.fact_days.length > 0 && state.children > 0),
    `done (${state.fact_days.length} fact) with ${state.children} sub-task; the completion waited: ${raced.secondWaited}`,
  );
});

// GoalLog 5. The person gives the task an estimate while the AI adds a sub-task under it.
test("5: a sub-task added while the task takes an estimate never leaves a parent with its own estimate", async () => {
  const taskId = await monthTask("estimada mientras");
  const raced = await interleave(
    door,
    admin,
    () => as(() => oneOffs.editTask({ oneOffId: taskId, name: "M8 estimada mientras", estimate: 60 })),
    addChild(taskId),
  );
  assert.deepEqual(raced.first.value, { ok: true }, "the estimate is written");
  const state = await stateOf(taskId);
  assert.ok(
    !(state.estimate !== null && state.children > 0),
    `estimate ${state.estimate} with ${state.children} sub-task; the sub-task waited: ${raced.secondWaited}`,
  );
});

// GoalLog 6 (RP-06). The task is marked done today while another device moves it to tomorrow.
test("6: a task moved while it is being completed keeps its fact on the task's own day", async () => {
  const taskId = await looseToday("movida mientras");
  const raced = await interleave(
    door,
    admin,
    () => as(() => oneOffs.completeOneOff({ oneOffId: taskId })),
    () => as(() => oneOffs.scheduleOneOff({ oneOffId: taskId, day: tomorrow })),
  );
  assert.equal(raced.first.error, undefined, "completeOneOff threw");
  const state = await stateOf(taskId);
  assert.deepEqual(state.fact_days, [today], "one fact, today");
  assert.equal(state.day, today, `the task moved to ${state.day} under its fact of ${today}`);
});

test("completing a task opens one transaction", async () => {
  const taskId = await looseToday("una transacción");
  door.resetBegins();
  const result = await as(() => oneOffs.completeOneOff({ oneOffId: taskId }));
  const begins = door.begins();
  assert.equal(result.ok, true);
  assert.equal(begins, 1, `completeOneOff opened ${begins} transactions`);
});

// GoalLog 9. 30 stored on the phone; the laptop's stale «Anotar» sends 45.
async function quantityHabit(label: string): Promise<string> {
  const goalId = await measuredGoal(label);
  const made = await as(() =>
    plan.addCommitment({
      goalId,
      name: `M8 ${label}`,
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never),
  );
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  return made.commitmentId;
}

async function storedQuantities(commitmentId: string): Promise<number[]> {
  const rows = await admin<{ quantity: number }[]>`
    select quantity from goals.facts where commitment_id = ${commitmentId} and day = ${today}`;
  return rows.map((row) => row.quantity);
}

test("9: a stale «Anotar» of another quantity is refused with the quantity kept, and the stored one stands", async () => {
  const commitmentId = await quantityHabit("anotar viejo");
  const first = await as(() => facts.declareFact({ commitmentId, quantity: 30 }));
  assert.equal(first.ok, true);
  const stale = await as(() => facts.declareFact({ commitmentId, quantity: 45 }));
  assert.deepEqual(stale, { ok: false, error: "day.errors.alreadyNoted", values: { quantity: 30 } });
  assert.deepEqual(await storedQuantities(commitmentId), [30]);
});

test("9: the same quantity sent again is the fact already there", async () => {
  const commitmentId = await quantityHabit("anotar igual");
  const first = await as(() => facts.declareFact({ commitmentId, quantity: 30 }));
  const again = await as(() => facts.declareFact({ commitmentId, quantity: 30 }));
  assert.equal(first.ok, true);
  assert.deepEqual(again, first);
  assert.deepEqual(await storedQuantities(commitmentId), [30]);
});

test("9: the refusal tells the person what is kept", () => {
  const messages = JSON.parse(readFileSync(resolve(process.cwd(), "messages/es/day.json"), "utf8"));
  const t = createTranslator({ locale: "es", messages: { day: messages }, namespace: "day" }) as unknown as (
    key: string,
    values: Record<string, unknown>,
  ) => string;
  assert.equal(t("errors.alreadyNoted", { quantity: 30 }), "Ya anotaste 30 hoy en otro lado. Ábrelo para cambiarlo.");
});
