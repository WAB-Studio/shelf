import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, mock } from "node:test";

import mcp from "../../messages/es/mcp.json";

import type { ChatTurn } from "./types";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_CHAT_STUB?: string; PULSAR_CHAT_BENCH_MODEL?: string } = {};
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
    editTask: act("editTask"),
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
    setGoalMeasure: act("setGoalMeasure"),
    setGoalNote: act("setGoalNote"),
  },
});
mock.module("@/app/actions/plan-edit", { namedExports: { editPhase: act("editPhase") } });
mock.module("@/app/actions/roadmap", { namedExports: { setRhythm: act("setRhythm") } });
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
  delete fakeEnv.PULSAR_CHAT_BENCH_MODEL;
  delete process.env.VERCEL;
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  if (realVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = realVercel;
});

test("a two-round conversation: a read runs, a write becomes one change and never runs, the model is gpt-5.6-luna", async () => {
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
  assert.ok(sent.every((request) => request.body.model === "gpt-5.6-luna"));
  assert.ok(sent.every((request) => request.url === "https://api.openai.com/v1/chat/completions"));
});

test("the tools offered are the 26 of the catalogue", async () => {
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

const forever = (inputTokens: number) => () => calling("c", "get_today", {}, { prompt_tokens: inputTokens, completion_tokens: 5 });

test("the input ceiling is 120 000 tokens", async () => {
  const model = (await import("./model")) as Record<string, unknown>;
  assert.equal(model.CHAT_INPUT_TOKENS_MAX, 120_000);
});

test("a looping model stops once the summed input passes the ceiling, and the failure carries what was spent", async () => {
  script(forever(70_000));
  const result = await answer();
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 140_000, output: 10 });
  assert.equal(sent.length, 2);
});

test("a sum of exactly the ceiling goes on to a third round", async () => {
  script(forever(60_000));
  const result = await answer();
  assert.equal(sent.length, 3);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 180_000, output: 15 });
});

test("a round that answers with no calls is kept whatever the total", async () => {
  script(
    () => calling("c1", "get_today", {}, { prompt_tokens: 50_000, completion_tokens: 5 }),
    () => saying("Listo.", { prompt_tokens: 130_000, completion_tokens: 7 }),
  );
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.reply, "Listo.");
  assert.deepEqual(result.usage, { input: 180_000, output: 12 });
});

test("cheap rounds that never stop are cut by the five-round cap", async () => {
  script(forever(10));
  const result = await answer();
  assert.equal(sent.length, 5);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 50, output: 25 });
});

// M4: outcomes of earlier proposals, the round cap, one deadline, the bench seam, the turns sent.
const fixIt = () => calling("w", "fix_task", { one_off_id: "task-1", month: "2026-11" });
const readIt = () => calling("r", "get_today", {});

test("M4 outcomes sent: a made, a refused and an open change read hecha, rechazada, sin hacer, in that order, after the turn's text", async () => {
  script(() => saying("Listo."));
  const turns: ChatTurn[] = [
    { role: "person", text: "haz tres cosas" },
    {
      role: "chat",
      text: "Propongo tres cosas.",
      changes: [
        { tool: "fix_task", input: {}, state: "made" },
        { tool: "create_goal", input: {}, state: "refused" },
        { tool: "declare_fact", input: {}, state: "open" },
      ],
    },
    { role: "person", text: "gracias" },
  ];
  await answer(turns);
  const messages = sent[0].body.messages;
  assert.equal(messages.length, 4);
  const content = messages[2].content!;
  assert.equal(messages[2].role, "assistant");
  assert.ok(content.startsWith("Propongo tres cosas."), content);
  assert.deepEqual(content.split("\n").slice(-3), [
    "[propuesta fix_task: hecha]",
    "[propuesta create_goal: rechazada]",
    "[propuesta declare_fact: sin hacer]",
  ]);
  assert.equal(messages[1].content, "haz tres cosas");
  assert.equal(messages[3].content, "gracias");
});

test("M4 outcomes sent: a chat turn with an empty reply and one change still tells the model its outcome", async () => {
  script(() => saying("Listo."));
  await answer([
    { role: "person", text: "a" },
    { role: "chat", text: "", changes: [{ tool: "fix_task", input: {}, state: "made" }] },
    { role: "person", text: "b" },
  ]);
  assert.match(sent[0].body.messages[2].content!, /\[propuesta fix_task: hecha\]$/);
});

test("M4 text unchanged: a chat turn with no change and the person's turns go byte for byte, the system prompt as before", async () => {
  script(() => saying("Listo."), () => saying("Listo."));
  const text = "Vas bien.\n\n  Dos líneas, con espacios al final  ";
  await answer([
    { role: "person", text: "¿Cómo voy?" },
    { role: "chat", text, changes: [] },
    { role: "person", text: "ok" },
  ]);
  const withChat = sent[0].body.messages;
  assert.equal(withChat[2].content, text);
  assert.equal(withChat[1].content, "¿Cómo voy?");
  await answer([{ role: "person", text: "ok" }]);
  assert.equal(withChat[0].content, sent[0].body.messages[0].content);
});

test("M4 proposals at the cap: a model that proposes one write per round for ever answers ok with its 5 changes and no reply", async () => {
  script(fixIt);
  const result = await answer();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.reply, "");
  assert.equal(result.changes.length, 5);
  assert.equal(sent.length, 5);
  assert.deepEqual(result.usage, { input: 500, output: 100 });
  assert.deepEqual(acts, []);
});

test("M4 nothing proposed at the cap: a model that only reads for ever is failed, its usage kept, no change", async () => {
  script(readIt);
  const result = await answer();
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 500, output: 100 });
  assert.equal("changes" in result, false);
});

function clock(start: number) {
  const state = { now: start };
  mock.method(Date, "now", () => state.now);
  mock.method(performance, "now", () => state.now);
  return state;
}

function slowModel(state: { now: number }, per: number, reply: () => Response, startedAt: number[], timeouts: number[]) {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return realTimeout(ms);
  });
  sent.length = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    startedAt.push(state.now);
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    state.now += per;
    return reply();
  }) as typeof fetch;
}

test("M4 one deadline: a model taking 30 s a round gets no round started after 48 s and is answered by 50 s with what it proposed", async () => {
  const start = 5_000_000;
  const state = clock(start);
  const startedAt: number[] = [];
  slowModel(state, 30_000, fixIt, startedAt, []);
  const result = await answer();
  assert.ok(startedAt.every((at) => at - start <= 48_000), JSON.stringify(startedAt));
  assert.ok(state.now - start <= 60_000);
  assert.equal(sent.length, 2);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.reply, "");
  assert.equal(result.changes.length, 2);
});

test("M4 one deadline: a round that would start with under 2 s left does not start", async () => {
  const start = 5_000_000;
  const state = clock(start);
  slowModel(state, 49_000, fixIt, [], []);
  const result = await answer();
  assert.equal(sent.length, 1);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.changes.length, 1);
});

test("M4 one deadline: past it with only reads the answer is failed with the usage spent", async () => {
  const state = clock(5_000_000);
  slowModel(state, 30_000, readIt, [], []);
  const result = await answer();
  assert.equal(sent.length, 2);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { input: 200, output: 40 });
});

test("M4 timeout shrinks: each round's timeout is at most the time left before the 50 s deadline", async () => {
  const state = clock(5_000_000);
  const timeouts: number[] = [];
  slowModel(state, 30_000, fixIt, [], timeouts);
  await answer();
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= 50_000, String(timeouts[0]));
  assert.ok(timeouts[1] > 0 && timeouts[1] <= 20_000, String(timeouts[1]));
});

test("M4 timeout: a quick model keeps a timeout well under the route's 60 s", async () => {
  clock(5_000_000);
  const timeouts: number[] = [];
  slowModel({ now: 5_000_000 }, 0, () => saying("hola"), [], timeouts);
  await answer();
  assert.deepEqual(timeouts.map((ms) => ms <= 50_000), [true]);
});

test("M4 bench seam off in Vercel: VERCEL set and a bench model set, the request still carries gpt-5.6-luna", async () => {
  process.env.VERCEL = "1";
  fakeEnv.PULSAR_CHAT_BENCH_MODEL = "gpt-bench-x";
  script(() => saying("hola"));
  await answer();
  assert.equal(sent[0].body.model, "gpt-5.6-luna");
});

test("M4 bench seam on locally: VERCEL unset and the seam set, the request carries the bench model; unset, gpt-5.6-luna", async () => {
  fakeEnv.PULSAR_CHAT_BENCH_MODEL = "gpt-bench-x";
  script(() => saying("hola"));
  await answer();
  assert.equal(sent[0].body.model, "gpt-bench-x");
  delete fakeEnv.PULSAR_CHAT_BENCH_MODEL;
  script(() => saying("hola"));
  await answer();
  assert.equal(sent[0].body.model, "gpt-5.6-luna");
});

test("M4 20 turns sent: 25 turns reach the model as the system prompt and the last 20", async () => {
  script(() => saying("hola"));
  const turns: ChatTurn[] = Array.from({ length: 25 }, (_, i) =>
    i % 2 === 0 ? { role: "person", text: `t${i}` } : { role: "chat", text: `t${i}`, changes: [] },
  );
  await answer(turns);
  const messages = sent[0].body.messages;
  assert.equal(messages.length, 21);
  assert.equal(messages[1].content, "t5");
  assert.equal(messages[20].content, "t24");
});

test("reasoning_effort per family: omitted for gpt-4.1 and gpt-4o, none for gpt-6 and gpt-5.6, low for the rest", async () => {
  const { reasoningEffortFor } = await import("./model");
  for (const model of ["gpt-5-mini", "gpt-5-nano", "o3", "o4-mini"]) assert.equal(reasoningEffortFor(model), "low", model);
  for (const model of ["gpt-6-luna", "gpt-6", "gpt-5.6-luna"]) assert.equal(reasoningEffortFor(model), "none", model);
  for (const model of ["gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"]) assert.equal(reasoningEffortFor(model), undefined, model);
});

test("the request body carries reasoning_effort none for gpt-5.6-luna, low for gpt-5-mini and none of it for gpt-4.1-nano; chatModel follows the seam", async () => {
  const { chatModel } = await import("./model");
  assert.equal(chatModel(), "gpt-5.6-luna");
  script(() => saying("hola"));
  await answer();
  assert.equal((sent[0].body as Record<string, unknown>).reasoning_effort, "none");
  fakeEnv.PULSAR_CHAT_BENCH_MODEL = "gpt-5-mini";
  script(() => saying("hola"));
  await answer();
  assert.equal((sent[0].body as Record<string, unknown>).reasoning_effort, "low");
  fakeEnv.PULSAR_CHAT_BENCH_MODEL = "gpt-4.1-nano";
  assert.equal(chatModel(), "gpt-4.1-nano");
  script(() => saying("hola"));
  await answer();
  const body = sent[0].body as Record<string, unknown>;
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_completion_tokens, 4000);
  fakeEnv.PULSAR_CHAT_BENCH_MODEL = "gpt-6-luna";
  script(() => saying("hola"));
  await answer();
  assert.equal((sent[0].body as Record<string, unknown>).reasoning_effort, "none");
  process.env.VERCEL = "1";
  assert.equal(chatModel(), "gpt-5.6-luna");
});
