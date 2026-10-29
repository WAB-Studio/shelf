// Proves RP-39, RP-56 and RP-45 for the AI's notes at the door: every read
// that names a task carries its note, `create_task` takes one, and
// `set_task_note` writes and replaces it but never empties it. Raw JSON-RPC
// over HTTP to the lane's running server, as `route.ts` does.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import { todayInZone } from "@/lib/zone";

import day from "../../messages/es/day.json";
import mcp from "../../messages/es/mcp.json";

const lane = Number(process.env.HARNESS_LANE ?? "1");
const base = (process.env.PULSAR_BASE_URL ?? `http://localhost:${3200 + lane - 1}`).replace(/\/+$/, "");

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
(globalThis as unknown as { sql: unknown }).sql = door;

let subject: Person;
let intruder: Person;
let goal: string;
let intruderTask: string;
const month = todayInZone().slice(0, 7);

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
async function rpc(key: string, method: string, params?: unknown) {
  counter += 1;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: counter, method, params }),
  });
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  const text = await response.text();
  const frame = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5);
  return JSON.parse(frame);
}

async function tool(name: string, args: Record<string, unknown>) {
  const reply = await rpc(subject.key, "tools/call", { name, arguments: args });
  assert.equal(reply.error, undefined, `${name}: ${JSON.stringify(reply.error)}`);
  const text: string = reply.result.content[0].text;
  return { isError: reply.result.isError === true, body: JSON.parse(text) as Record<string, unknown>, text };
}

const noteOf = async (id: string) => (await admin`select note from goals.one_offs where id = ${id}`)[0].note as string | null;

before(async () => {
  installStubs();
  const acts = await import("@/app/actions/plan");
  const oneOffs = await import("@/app/actions/one-offs");
  const session = await import("@/lib/session");
  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  const horizon = new Date(`${todayInZone()}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 120);
  const as = (person: Person) => <T>(fn: () => Promise<T>) =>
    session.actAs({ id: person.id, email: person.email } as never, fn);

  goal = await as(subject)(async () => {
    const made = await acts.createGoal({ name: "notas", horizon: horizon.toISOString().slice(0, 10) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    return made.goalId;
  });
  intruderTask = await as(intruder)(async () => {
    const made = await oneOffs.createOneOff({ name: "ajena", day: null, note: "nota ajena" } as never);
    if (!made.ok) throw new Error(`createOneOff intruder: ${made.error}`);
    return made.oneOffId as string;
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

test("tools/list names set_task_note, says it never empties, and holds no name that deletes", async () => {
  const reply = await rpc(subject.key, "tools/list");
  const names: string[] = reply.result.tools.map((entry: { name: string }) => entry.name);
  assert.ok(names.includes("set_task_note"));
  assert.deepEqual(names.filter((name) => /delete|archive|remove|undo|revoke/.test(name)), []);
  const entry = reply.result.tools.find((item: { name: string }) => item.name === "set_task_note");
  assert.equal(entry.description, mcp.tools.set_task_note);
  assert.match(entry.description, /reemplaza/);
  assert.match(entry.description, /Nunca la vacía/);
});

test("set_task_note on a done task writes, get_month reads it back, and a second call replaces it", async () => {
  const created = await tool("create_task", { name: "hecha", goal_id: goal, planned_month: month, note: "  primera\r\nlínea  " });
  assert.equal(created.isError, false, created.text);
  const id = created.body.oneOffId as string;
  assert.equal(await noteOf(id), "primera\nlínea");

  assert.equal((await tool("complete_task", { one_off_id: id })).isError, false);
  const written = await tool("set_task_note", { one_off_id: id, note: "ya hecha, con nota" });
  assert.equal(written.isError, false, written.text);
  assert.match((await tool("get_month", { goal_id: goal, month })).text, /ya hecha, con nota/);

  assert.equal((await tool("set_task_note", { one_off_id: id, note: "otra" })).isError, false);
  assert.equal(await noteOf(id), "otra");
});

test("2001 characters return the act's reason and the note stands", async () => {
  const created = await tool("create_task", { name: "larga", note: "corta" });
  const id = created.body.oneOffId as string;
  const refused = await tool("set_task_note", { one_off_id: id, note: "x".repeat(2001) });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.key, "day.errors.oneOffNoteTooLong");
  assert.equal(refused.body.message, day.errors.oneOffNoteTooLong);
  assert.equal(await noteOf(id), "corta");
});

test("a blank note returns noteEmpty and the note is unchanged", async () => {
  const created = await tool("create_task", { name: "vacía", note: "intacta" });
  const id = created.body.oneOffId as string;
  for (const note of ["", "   ", "\n\t "]) {
    const refused = await tool("set_task_note", { one_off_id: id, note });
    assert.equal(refused.isError, true);
    assert.equal(refused.body.key, "mcp.errors.noteEmpty");
    assert.equal(refused.body.message, mcp.errors.noteEmpty);
    assert.equal(await noteOf(id), "intacta");
  }
});

test("another person's task answers not found and keeps its note", async () => {
  const refused = await tool("set_task_note", { one_off_id: intruderTask, note: "invasión" });
  assert.equal(refused.isError, true);
  assert.equal(refused.body.key, "day.errors.notFound");
  assert.equal(await noteOf(intruderTask), "nota ajena");
});

test("get_today, get_goal, get_report and list_loose_one_offs show the note", async () => {
  const dated = await tool("create_task", { name: "con día", day: todayInZone(), note: "nota-hoy" });
  assert.equal(dated.isError, false, dated.text);
  assert.match((await tool("get_today", {})).text, /nota-hoy/);

  const loose = await tool("create_task", { name: "suelta", note: "nota-suelta" });
  assert.match((await tool("list_loose_one_offs", {})).text, /nota-suelta/);

  const owned = await tool("create_task", { name: "del mes", goal_id: goal, planned_month: month, note: "nota-meta" });
  assert.equal(owned.isError, false, owned.text);
  assert.match((await tool("get_goal", { goal_id: goal })).text, /nota-meta/);

  // A task from an earlier month, undone, reaches the report as carried.
  const earlier = new Date(`${month}-01T12:00:00Z`);
  earlier.setUTCMonth(earlier.getUTCMonth() - 1);
  await admin`update goals.one_offs set planned_month = ${earlier.toISOString().slice(0, 10)}, note = 'nota-arrastrada'
    where id = ${owned.body.oneOffId as string}`;
  const report = await tool("get_report", {});
  assert.equal(report.isError, false, report.text);
  assert.match(report.text, /nota-arrastrada/);
  assert.ok(loose.body.oneOffId);
});
