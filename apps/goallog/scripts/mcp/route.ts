// Proves RP-38, RP-39, RP-56, RNP-05, RNP-14 and RNP-15 at the door: raw
// JSON-RPC over HTTP to the lane's running server (`PULSAR_BASE_URL`, else
// :3200 + lane - 1), keys issued by `lib/people.ts`. The server's log is read
// from `PULSAR_SERVER_LOG` (default `private/dev<port>.log`) for the two
// facts only it can show: no Auth call, and no key in a line. A Next server
// logs no outbound call, so start it with
//   NODE_OPTIONS='--import data:text/javascript,const%20f=fetch;globalThis.fetch=(i,o)=>{console.log(%22[outbound]%22,String(i.url??i));return%20f(i,o)}'
// `before` proves the log sees Auth by sending one bogus /auth/confirm first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import { todayInZone } from "@/lib/zone";

import mcp from "../../messages/es/mcp.json";
import roadmap from "../../messages/es/roadmap.json";

const lane = Number(process.env.HARNESS_LANE ?? "1");
const base = (process.env.PULSAR_BASE_URL ?? `http://localhost:${3200 + lane - 1}`).replace(/\/+$/, "");
const logPath = resolve(process.cwd(), process.env.PULSAR_SERVER_LOG ?? `private/dev${new URL(base).port}.log`);
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
const challenge = `resource_metadata="${siteUrl}/.well-known/oauth-protected-resource/mcp"`;

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
(globalThis as unknown as { sql: unknown }).sql = door;

let subject: Person;
let intruder: Person;
let goal: string;
let intruderGoal: string;
let logStart = 0;

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

const serverLog = () => readFileSync(logPath, "utf8").slice(logStart);

let counter = 0;
async function post(headers: Record<string, string>, payload: unknown): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(payload),
  });
}

type Reply = {
  result?: {
    serverInfo: { name: string };
    instructions: string;
    tools: { name: string }[];
    content: { text: string }[];
    isError?: boolean;
  };
  error?: unknown;
};

// The reply is JSON or one SSE `data:` frame.
async function rpc(key: string, method: string, params?: unknown): Promise<Reply> {
  counter += 1;
  const response = await post({ Authorization: `Bearer ${key}` }, { jsonrpc: "2.0", id: counter, method, params });
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  const text = await response.text();
  const frame = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5);
  return JSON.parse(frame);
}

async function tool(key: string, name: string, args: Record<string, unknown>) {
  const reply = await rpc(key, "tools/call", { name, arguments: args });
  assert.equal(reply.error, undefined, `${name}: ${JSON.stringify(reply.error)}`);
  const text = reply.result!.content[0].text;
  assert.ok(text.startsWith("{"), `${name} answered a non-JSON body: ${text}`);
  return { isError: reply.result!.isError === true, body: JSON.parse(text) as Record<string, unknown>, result: reply.result! };
}

before(async () => {
  installStubs();
  const acts = await import("@/app/actions/plan");
  const session = await import("@/lib/session");
  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  const horizon = new Date(`${todayInZone()}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 120);
  const as = (person: Person) => <T>(fn: () => Promise<T>) =>
    session.actAs({ id: person.id, email: person.email } as never, fn);

  goal = await as(subject)(async () => {
    const made = await acts.createGoal({ name: "la puerta", horizon: horizon.toISOString().slice(0, 10) });
    if (!made.ok) throw new Error(`createGoal: ${made.error}`);
    const commitment = await acts.addCommitment({
      goalId: made.goalId,
      name: "estudiar",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 30,
      unit: "minutos",
    } as never);
    if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
    return made.goalId;
  });
  intruderGoal = await as(intruder)(async () => {
    const made = await acts.createGoal({ name: "ajena", horizon: horizon.toISOString().slice(0, 10) });
    if (!made.ok) throw new Error(`createGoal intruder: ${made.error}`);
    return made.goalId;
  });
  // The control: a call known to reach Auth must show in the log, or the
  // closing assertion proves nothing.
  await fetch(`${base}/auth/confirm?token_hash=control&type=magiclink`, { redirect: "manual" });
  assert.match(readFileSync(logPath, "utf8"), /\[outbound\].*\/auth\/v1\/verify/, "the server log does not show outbound calls");
  logStart = readFileSync(logPath, "utf8").length;
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("initialize names the server and carries the instructions", async () => {
  const reply = await rpc(subject.key, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "check", version: "0" },
  });
  assert.equal(reply.result!.serverInfo.name, "goallog");
  assert.equal(reply.result!.instructions, mcp.instructions);
});

test("tools/list lists the read and write tools and none that deletes or archives", async () => {
  const reply = await rpc(subject.key, "tools/list");
  const names: string[] = reply.result!.tools.map((entry: { name: string }) => entry.name);
  for (const name of ["list_goals", "get_goal", "get_month", "get_today", "create_task", "complete_task", "set_month_amount"]) {
    assert.ok(names.includes(name), `${name} missing`);
  }
  assert.equal(names.length, 6 + 18, names.join(","));
  assert.deepEqual(names.filter((name) => /delete|archive|remove|undo|revoke/.test(name)), []);
  for (const name of ["fix_task", "unfix_task"]) assert.ok(names.includes(name), `${name} missing`);
  for (const name of ["accept_shift", "move_task_to_month"]) assert.ok(!names.includes(name), `${name} must be gone`);
  const described = (name: string) => reply.result!.tools.find((entry: { name: string }) => entry.name === name) as unknown as { description: string };
  assert.match(described("fix_task").description, /la tarea queda en ese mes; las demás se acomodan/);
  assert.match(described("unfix_task").description, /las demás se acomodan/);
});

test("get_goal reads the subject's goal and refuses the intruder's as not found", async () => {
  const own = await tool(subject.key, "get_goal", { goal_id: goal });
  assert.equal(own.isError, false);
  assert.match(JSON.stringify(own.body), /la puerta/);

  const foreign = await tool(subject.key, "get_goal", { goal_id: intruderGoal });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.body.key, "mcp.errors.goalNotFound");
  assert.doesNotMatch(JSON.stringify(foreign.body), /ajena/);
});

test("create_task, set_month_amount and complete_task write and read back through the door", async () => {
  const month = todayInZone().slice(0, 7);
  const created = await tool(subject.key, "create_task", { name: "por la puerta", goal_id: goal, planned_month: month, estimate: 30 });
  assert.equal(created.isError, false, JSON.stringify(created.body));
  const taskId = created.body.oneOffId as string;
  assert.ok(taskId);

  const listed = await tool(subject.key, "get_month", { goal_id: goal, month });
  assert.match(JSON.stringify(listed.body), /por la puerta/);

  const planned = await tool(subject.key, "set_month_amount", { goal_id: goal, month, amount: 120 });
  assert.equal(planned.isError, false, JSON.stringify(planned.body));
  const [budget] = await door`select amount from goals.month_budgets where goal_id = ${goal}`;
  assert.equal(Number(budget.amount), 120);

  const done = await tool(subject.key, "complete_task", { one_off_id: taskId });
  assert.equal(done.isError, false, JSON.stringify(done.body));
  const today = await tool(subject.key, "get_today", {});
  assert.match(JSON.stringify(today.body), /por la puerta/);
  const facts = await admin`select id from goals.facts where one_off_id = ${taskId}`;
  assert.equal(facts.length, 1, "the task has no done fact");
});

test("fix_task fixes through the door, get_month reads it fixed and its part, unfix_task returns it to the plan", async () => {
  const key = subject.key;
  const monthAt = (delta: number) => {
    const index = Number(todayInZone().slice(0, 4)) * 12 + Number(todayInZone().slice(5, 7)) - 1 + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  };
  const [current, next] = [monthAt(0), monthAt(1)];
  const horizon = new Date(`${todayInZone()}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 120);

  const made = await tool(key, "create_goal", { name: "el ritmo", horizon: horizon.toISOString().slice(0, 10) });
  const goalId = made.body.goalId as string;
  const commitment = await tool(key, "add_commitment", {
    goal_id: goalId, name: "leer", cadence_kind: "daily", satisfaction: "quantity", target_quantity: 30, unit: "minutos",
  });
  assert.equal(commitment.isError, false, JSON.stringify(commitment.body));
  // Opened on the 1st, Bogotá's midnight: this month plans the whole 600 (RP-74) whatever the run date.
  await admin`update goals.goals set rhythm = 600, created_at = ${`${current}-01T00:00:00-05:00`} where id = ${goalId}`;

  const big = await tool(key, "create_task", { name: "tesis", goal_id: goalId, estimate: 900, in_plan: true });
  assert.equal(big.isError, false, JSON.stringify(big.body));
  const bigId = big.body.oneOffId as string;
  type Item = { name: string; part: { value: number }; from: string | null; to: string | null; fixed: boolean };
  const items = async (month: string) => ((await tool(key, "get_month", { goal_id: goalId, month })).body.items as Item[]);
  const brief = (item: Item | undefined) => item && [item.part.value, item.from, item.to, item.fixed];

  assert.deepEqual(brief((await items(current))[0]), [600, null, next, false]);
  assert.deepEqual(brief((await items(next))[0]), [300, current, null, false]);
  const split = (await tool(key, "get_goal", { goal_id: goalId })).body as {
    rhythm: { value: number }; end: string; tasks: { name: string; month: string; fixed: boolean }[];
  };
  assert.equal(split.rhythm.value, 600);
  assert.match(split.end, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([split.tasks[0].month, split.tasks[0].fixed], [current, false]);

  const later = monthAt(2);
  const fixed = await tool(key, "fix_task", { one_off_id: bigId, month: later });
  assert.equal(fixed.isError, false, JSON.stringify(fixed.body));
  assert.deepEqual((await items(current)).map((item) => item.name), []);
  assert.deepEqual(brief((await items(later))[0]), [900, null, null, true]);
  const pinned = (await tool(key, "get_goal", { goal_id: goalId })).body as { tasks: { month: string; fixed: boolean }[]; rhythm: { value: number } };
  assert.deepEqual([pinned.tasks[0].month, pinned.tasks[0].fixed, pinned.rhythm.value], [later, true, 600]);
  const [{ rhythm }] = await admin`select rhythm from goals.goals where id = ${goalId}`;
  assert.equal(rhythm, 600, "fixing never changes the goal's rhythm");

  const unfixed = await tool(key, "unfix_task", { one_off_id: bigId });
  assert.equal(unfixed.isError, false, JSON.stringify(unfixed.body));
  assert.deepEqual(brief((await items(current))[0]), [600, null, next, false]);

  assert.equal((await tool(key, "complete_task", { one_off_id: bigId })).isError, false);
  const refused = await tool(key, "fix_task", { one_off_id: bigId, month: next });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.body, { key: "roadmap.errors.doneTask", message: roadmap.errors.doneTask });
});

test("tools that delete or archive answer a JSON-RPC error and the rows stand", async () => {
  for (const name of ["delete_one_off", "archive_goal"]) {
    const reply = await rpc(subject.key, "tools/call", { name, arguments: { goal_id: goal, one_off_id: goal } });
    const failed = reply.error !== undefined || reply.result?.isError === true;
    assert.ok(failed, `${name} did not fail`);
  }
  const [row] = await admin`select archived_at from goals.goals where id = ${goal}`;
  assert.equal(row.archived_at, null);
});

async function refusedWith(headers: Record<string, string>): Promise<void> {
  const response = await post(headers, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401);
  const header = response.headers.get("www-authenticate") ?? "";
  assert.match(header, /^Bearer /);
  assert.ok(header.includes(challenge), header);
  assert.equal(response.headers.get("cache-control"), "no-store");
  await response.text();
}

test("no header, a malformed header, an unknown key and a key off by one character each answer 401", async () => {
  await refusedWith({});
  await refusedWith({ Authorization: "Basic abc" });
  await refusedWith({ Authorization: "Bearer" });
  await refusedWith({ Authorization: "Bearer pls_notakeyatall" });
  const last = subject.key.slice(-1);
  await refusedWith({ Authorization: `Bearer ${subject.key.slice(0, -1)}${last === "A" ? "B" : "A"}` });
});

test("a revoked key answers 401 while the subject's other key still lists", async () => {
  const { issueKeyFor } = await import("./lib/people");
  const second = await issueKeyFor(door, subject, "second");
  assert.equal((await rpc(second.key, "tools/list")).error, undefined);
  await admin`update goals.access_tokens set revoked_at = now() where id = ${second.id}`;
  await refusedWith({ Authorization: `Bearer ${second.key}` });
  assert.equal((await rpc(subject.key, "tools/list")).error, undefined);
});

test("the browser session alone never authenticates, and does not rescue a bad key", async () => {
  const stored = JSON.parse(readFileSync(resolve(process.cwd(), `private/session-${lane}.json`), "utf8"));
  const cookie = stored.cookies.map((entry: { name: string; value: string }) => `${entry.name}=${entry.value}`).join("; ");
  await refusedWith({ Cookie: cookie });
  await refusedWith({ Cookie: cookie, Authorization: "Bearer pls_notakeyatall" });
});

test("the metadata document answers at both well-known paths with the contract's fields", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const document = await response.json();
    assert.equal(document.resource, `${siteUrl}/mcp`);
    assert.deepEqual(document.authorization_servers, [siteUrl]);
    assert.deepEqual(document.bearer_methods_supported, ["header"]);
    assert.equal(document.resource_name, "goallog");
  }
  const preflight = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { method: "OPTIONS" });
  assert.ok(preflight.status < 300);
});

test("GET and DELETE on /mcp refuse a missing or unknown key with 401 and the challenge", async () => {
  for (const method of ["GET", "DELETE"]) {
    for (const headers of [{}, { Authorization: "Bearer pls_notakeyatall" }] as Record<string, string>[]) {
      const response = await fetch(`${base}/mcp`, { method, headers: { Accept: "application/json, text/event-stream", ...headers } });
      assert.equal(response.status, 401, `${method} ${JSON.stringify(headers)}`);
      assert.ok((response.headers.get("www-authenticate") ?? "").includes(challenge), method);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.text();
    }
  }
});

test("GET and DELETE on /mcp with a live key pass the door and meet the stateless transport's 405, uncached", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(`${base}/mcp`, {
      method,
      headers: { Accept: "application/json, text/event-stream", Authorization: `Bearer ${subject.key}` },
    });
    await response.body?.cancel();
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("cache-control"), "no-store", method);
    assert.equal(response.headers.get("www-authenticate"), null, method);
  }
});

test("a key is echoed in no body and no header, whether the call works or is malformed", async () => {
  const tail = subject.key.slice(4);
  const sent = [
    { jsonrpc: "2.0", id: 91, method: "tools/list" },
    { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "get_goal", arguments: { goal_id: 42 } } },
    { jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "nope", arguments: null } },
    { jsonrpc: "2.0", id: 94, method: "tools/call" },
  ];
  for (const payload of sent) {
    const response = await post({ Authorization: `Bearer ${subject.key}` }, payload);
    const everything = `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;
    assert.equal(everything.includes(subject.key), false, JSON.stringify(payload));
    assert.equal(everything.includes(tail), false, JSON.stringify(payload));
  }
});

test("the server log holds no Auth call and no key", () => {
  const log = serverLog();
  assert.doesNotMatch(log, /\/auth\/v1\//);
  // A request with no key is refused at the door; reaching the lookup throws there.
  assert.doesNotMatch(log, /Unexpected error authenticating/);
  for (const key of [subject.key, intruder.key]) assert.equal(log.includes(key), false);
  assert.equal(log.includes(subject.key.slice(4)), false);
});
