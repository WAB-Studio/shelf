import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";

import mcp from "../../messages/es/mcp.json";

import type { ChatTurn } from "./types";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_CHAT_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const acts: string[] = [];
const reads: string[] = [];
const act = (name: string) => async () => {
  acts.push(name);
  return { ok: true };
};
mock.module("@/app/actions/budgets", { namedExports: { setMonthBudget: act("setMonthBudget") } });
mock.module("@/app/actions/facts", { namedExports: { declareFact: act("declareFact") } });
mock.module("@/app/actions/one-offs", {
  namedExports: {
    completeOneOff: act("completeOneOff"),
    createOneOff: act("createOneOff"),
    fixTask: act("fixTask"),
    scheduleOneOff: act("scheduleOneOff"),
    setOneOffNote: act("setOneOffNote"),
  },
});
mock.module("@/app/actions/plan", {
  namedExports: {
    addCommitment: act("addCommitment"),
    addPhase: act("addPhase"),
    createGoal: act("createGoal"),
    moveGoal: act("moveGoal"),
    moveHorizon: act("moveHorizon"),
    renameGoal: act("renameGoal"),
    retireCommitment: act("retireCommitment"),
    setGoalNote: act("setGoalNote"),
  },
});
mock.module("@/lib/queries/day", {
  namedExports: {
    loadDay: async () => {
      reads.push("loadDay");
      return {};
    },
  },
});
mock.module("@/lib/queries/goal", {
  namedExports: {
    listGoalsForMetas: async () => {
      reads.push("listGoalsForMetas");
      return { open: [], ended: [], archived: [] };
    },
    listLooseCommitments: async () => {
      reads.push("listLooseCommitments");
      return [];
    },
    loadGoal: async () => {
      reads.push("loadGoal");
      return null;
    },
  },
});
mock.module("@/lib/queries/one-offs", {
  namedExports: {
    listDaylessOneOffs: async () => {
      reads.push("listDaylessOneOffs");
      return [{ id: "task-maze", name: "Maze" }];
    },
    listScheduledOneOffs: async () => [],
  },
});
mock.module("@/lib/queries/report", { namedExports: { loadReport: async () => ({}) } });
mock.module("@/lib/plan/roadmap-read", { namedExports: { planMonthList: () => [] } });
mock.module("@/lib/mcp/shape", {
  namedExports: {
    shapeDay: () => ({ today: "READ-VALUE" }),
    shapeGoal: () => ({}),
    shapeGoalList: () => ({ open: [{ id: "g-1", name: "Inglés" }], ended: [], archived: [] }),
    shapeLoose: (input: { dayless: { id: string; name: string }[] }) => ({ dayless: input.dayless, scheduled: [] }),
    shapeMonth: () => ({}),
    shapeReport: () => ({}),
  },
});

type Sent = { url: string; body: { model: string; tools: { function: { name: string } }[]; messages: { role: string; content?: string }[] } };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
const realVercel = process.env.VERCEL;

function script(...replies: (() => Response | Promise<Response>)[]) {
  sent.length = 0;
  let i = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const make = replies[Math.min(i++, replies.length - 1)];
    return make();
  }) as typeof fetch;
}

const completion = (message: object, usage: object | null = { prompt_tokens: 100, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message }], usage }), { status: 200 });
const calling = (id: string, name: string, args: object | string, usage?: object) =>
  completion(
    { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
    usage,
  );
const saying = (content: string, usage?: object) => completion({ content }, usage);

const ask = (text = "pasa Maze a octubre"): ChatTurn[] => [{ role: "person", text }];
const answer = async (turns = ask()) => (await import("./model")).answerChat(turns);

beforeEach(() => {
  acts.length = 0;
  reads.length = 0;
  fakeEnv.OPENAI_API_KEY = "sk-test";
  delete fakeEnv.PULSAR_CHAT_STUB;
  delete process.env.VERCEL;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = realVercel;
});

test("a two-round conversation: a read runs, a write becomes one change and never runs, the model is gpt-5-mini", async () => {
  script(
    () => calling("c1", "get_today", {}, { prompt_tokens: 100, completion_tokens: 20 }),
    () => calling("c2", "fix_task", { one_off_id: "task-1", month: "2026-11" }, { prompt_tokens: 50, completion_tokens: 10 }),
    () => saying("Propongo fijarla en noviembre.", { prompt_tokens: 0, completion_tokens: 0 }),
  );
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.reply, "Propongo fijarla en noviembre.");
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].tool, "fix_task");
  assert.deepEqual(result.changes[0].input, { one_off_id: "task-1", month: "2026-11" });
  assert.match(result.changes[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.usage, { input: 150, output: 30 });
  assert.deepEqual(reads, ["loadDay"]);
  assert.deepEqual(acts, []);
  assert.ok(sent.every((request) => request.body.model === "gpt-5-mini"));
  assert.ok(sent.every((request) => request.url === "https://api.openai.com/v1/chat/completions"));
});

test("the tools offered are the 22 of the catalogue", async () => {
  script(() => saying("hola"));
  await answer();
  assert.deepEqual(sent[0].body.tools.map((tool) => tool.function.name).sort(), Object.keys(mcp.tools).sort());
});

test("a read's value reaches the model in the next request", async () => {
  script(() => calling("c1", "get_today", {}), () => saying("listo"));
  await answer();
  const tool = sent[1].body.messages.find((message) => message.role === "tool");
  assert.match(tool?.content ?? "", /READ-VALUE/);
});

test("an unknown tool is answered as an error and never becomes a change", async () => {
  script(() => calling("c1", "archive_goal", { goal_id: "g" }), () => saying("no puedo"));
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.changes.length, 0);
  const tool = sent[1].body.messages.find((message) => message.role === "tool");
  assert.match(tool?.content ?? "", /error/);
});

test("a write with bad input is refused before it is proposed", async () => {
  script(() => calling("c1", "fix_task", { month: "2026-11" }), () => saying("falta la tarea"));
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.changes.length, 0);
  assert.deepEqual(acts, []);
  const tool = sent[1].body.messages.find((message) => message.role === "tool");
  assert.match(tool?.content ?? "", /error/);
});

test("arguments that are not JSON go back as an error", async () => {
  script(() => calling("c1", "fix_task", "{not json"), () => saying("ok"));
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.changes.length, 0);
});

test("a model that always calls a read stops at 5 requests with failed", async () => {
  script(() => calling("c", "get_today", {}));
  const result = await answer();
  assert.equal(result.status, "failed");
  assert.equal(sent.length, 5);
});

test("a non-200 and an abort are failed, never a throw", async () => {
  script(() => new Response("boom", { status: 500 }));
  assert.equal((await answer()).status, "failed");
  script(() => {
    throw new DOMException("aborted", "AbortError");
  });
  assert.equal((await answer()).status, "failed");
});

test("an answer with nothing in it is empty", async () => {
  script(() => saying("  "));
  assert.equal((await answer()).status, "empty");
});

test("only the last 20 turns are sent, after the system message", async () => {
  script(() => saying("ok"));
  const turns: ChatTurn[] = Array.from({ length: 25 }, (_, i) => ({ role: "person", text: `m${i}` }));
  await answer(turns);
  const messages = sent[0].body.messages;
  assert.equal(messages.length, 21);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content, "m5");
  assert.equal(messages[20].content, "m24");
});

test("no key and no stub: not available; a stub or a key makes it available", async () => {
  const { chatAvailable } = await import("./model");
  delete fakeEnv.OPENAI_API_KEY;
  assert.equal(chatAvailable(), false);
  fakeEnv.PULSAR_CHAT_STUB = "fail";
  assert.equal(chatAvailable(), true);
  process.env.VERCEL = "1";
  assert.equal(chatAvailable(), false);
  delete fakeEnv.PULSAR_CHAT_STUB;
  fakeEnv.OPENAI_API_KEY = "k";
  assert.equal(chatAvailable(), true);
});

test("with no key the call fails without touching the network", async () => {
  script(() => saying("x"));
  delete fakeEnv.OPENAI_API_KEY;
  assert.equal((await answer()).status, "failed");
  assert.equal(sent.length, 0);
});

test("stub fail answers failed with no request", async () => {
  script(() => saying("x"));
  fakeEnv.PULSAR_CHAT_STUB = "fail";
  assert.equal((await answer()).status, "failed");
  assert.equal(sent.length, 0);
});

test("stub script maps the person's text to one change with the placeholder resolved, no request", async () => {
  script(() => saying("x"));
  const dir = mkdtempSync(join(tmpdir(), "chat-stub-"));
  const path = join(dir, "script.json");
  writeFileSync(
    path,
    JSON.stringify({
      "pasa Maze": { reply: "Propongo pasarla.", calls: [{ name: "fix_task", arguments: { one_off_id: "{{task:Maze}}", month: "2026-11" } }] },
      "rompe": { fail: true },
    }),
  );
  fakeEnv.PULSAR_CHAT_STUB = `script:${path}`;
  const result = await answer(ask("pasa Maze"));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.reply, "Propongo pasarla.");
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0].input, { one_off_id: "task-maze", month: "2026-11" });
  assert.deepEqual(acts, []);
  assert.equal(sent.length, 0);

  assert.equal((await answer(ask("rompe"))).status, "failed");
  assert.equal((await answer(ask("otra cosa"))).status, "failed");
});

test("a stub placeholder the plan cannot resolve fails instead of staying literal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-stub-"));
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify({ x: { reply: "r", calls: [{ name: "fix_task", arguments: { one_off_id: "{{task:Nada}}", month: "2026-11" } }] } }));
  fakeEnv.PULSAR_CHAT_STUB = `script:${path}`;
  assert.equal((await answer(ask("x"))).status, "failed");
});
