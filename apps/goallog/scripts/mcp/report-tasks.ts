// Proves RP-39 and RP-49 at the door: `get_report` lists each goal's tasks as
// 256 reads them — the carried one first, then the month's own in plan order,
// done and not, every note — shaped in YYYY-MM and whole amounts. Rows are
// planted by direct SQL with positions that run against creation order. Raw
// JSON-RPC over HTTP to the lane's running server, as `route.ts` does.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import { todayInZone } from "@/lib/zone";

const lane = Number(process.env.HARNESS_LANE ?? "1");
const base = (process.env.PULSAR_BASE_URL ?? `http://localhost:${3200 + lane - 1}`).replace(/\/+$/, "");

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
(globalThis as unknown as { sql: unknown }).sql = door;

type Amount = { value: number; unit: string | null; text?: string };
type ReportTask = {
  name: string;
  from: string | null;
  done: boolean;
  doneOn: string | null;
  estimate: Amount | null;
  owes: Amount;
  hasAmount: boolean;
  note: string | null;
  children: { name: string; done: boolean; doneOn: string | null; estimate: Amount | null; note: string | null }[];
};

// Twenty-two tools here; this file adds none.
const TOOL_COUNT = 26;
let subject: Person;
let goal: string;
const today = todayInZone();

function monthFrom(day: string, delta: number): string {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

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

let counter = 0;
async function rpc(method: string, params?: unknown) {
  counter += 1;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${subject.key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: counter, method, params }),
  });
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  const text = await response.text();
  const frame = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5);
  return JSON.parse(frame);
}

async function reportTasks(): Promise<ReportTask[]> {
  const reply = await rpc("tools/call", { name: "get_report", arguments: {} });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.notEqual(reply.result.isError, true, reply.result.content[0].text);
  const goals = JSON.parse(reply.result.content[0].text).goals as { id: string; tasks: ReportTask[] }[];
  const found = goals.find((entry) => entry.id === goal);
  assert.ok(found, "the report does not hold the subject's goal");
  return found.tasks;
}

before(async () => {
  installStubs();
  const acts = await import("@/app/actions/plan");
  const session = await import("@/lib/session");
  const runId = await openCheckRun(admin);
  [subject] = await createPeople(admin, runId, door, 1);
  const horizon = `${monthFrom(today, 2)}-01`;
  goal = await session.actAs({ id: subject.id, email: subject.email } as never, async () => {
    const made = await acts.createGoal({ name: "informe tareas", horizon });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    return made.goalId;
  });
  // A measure in minutes, so the estimates read as whole minutes.
  await admin`update goals.goals set measure_unit = 'minutos', measure_name = 'Estudio' where id = ${goal}`;

  async function task(name: string, month: string | null, position: number, extra: { parent?: string; estimate?: number; note?: string } = {}) {
    const [row] = await admin<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, parent_id, estimate, note, position)
      values (${subject.id}, ${goal}, ${name}, ${month}, ${extra.parent ?? null}, ${extra.estimate ?? null},
              ${extra.note ?? null}, ${position})
      returning id`;
    return row.id;
  }
  async function doneOn(id: string, day: string) {
    await admin`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${subject.id}, ${goal}, ${id}, ${day})`;
  }
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastMonth = `${monthFrom(today, -1)}-01`;
  const open = await task("abierta", thisMonth, 3000020, { note: "nota madre" });
  const a = await task("hija hecha", null, 3000022, { parent: open, estimate: 30, note: "nota hija" });
  await task("hija abierta", null, 3000021, { parent: open, estimate: 50 });
  await doneOn(a, today);
  const done = await task("hecha", thisMonth, 3000010, { estimate: 90 });
  await doneOn(done, today);
  await task("arrastrada", lastMonth, 3000030, { estimate: 40, note: "nota arrastrada" });
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("get_report lists the three tasks in plan order with their done and from", async () => {
  const tasks = await reportTasks();
  assert.deepEqual(
    tasks.map((task) => [task.name, task.from, task.done]),
    [
      ["arrastrada", monthFrom(today, -1), false],
      ["hecha", null, true],
      ["abierta", null, false],
    ],
  );
  for (const task of tasks) assert.ok(task.from === null || /^\d{4}-\d{2}$/.test(task.from), `from ${task.from}`);
});

test("get_report gives a done task its day and whole minutes, never hours", async () => {
  const done = (await reportTasks()).find((task) => task.name === "hecha");
  assert.ok(done);
  assert.equal(done.doneOn, today);
  assert.equal(done.estimate?.value, 90);
  assert.equal(done.estimate?.unit, "minutos");
  assert.deepEqual(done.owes.value, 0);
});

test("get_report carries every note and the sub-tasks in order", async () => {
  const tasks = await reportTasks();
  assert.equal(tasks.find((task) => task.name === "arrastrada")?.note, "nota arrastrada");
  const open = tasks.find((task) => task.name === "abierta");
  assert.ok(open);
  assert.equal(open.note, "nota madre");
  assert.deepEqual([open.estimate, open.owes.value, open.hasAmount], [null, 50, true]);
  assert.deepEqual(
    open.children.map((child) => [child.name, child.done, child.doneOn, child.estimate?.value, child.note]),
    [
      ["hija abierta", false, null, 50, null],
      ["hija hecha", true, today, 30, "nota hija"],
    ],
  );
});

test("tools/list still holds the same tools", async () => {
  const reply = await rpc("tools/list");
  const names: string[] = reply.result.tools.map((entry: { name: string }) => entry.name);
  assert.equal(names.length, TOOL_COUNT);
  assert.equal(names.filter((name) => name === "get_report").length, 1);
});
