import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import type { DraftGoal, DraftTask, ImportDraft } from "@/lib/import/draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const timeouts: number[] = [];

function stubFetch(reply: () => Response) {
  calls.length = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as typeof fetch;
  AbortSignal.timeout = ((ms: number) => {
    timeouts.push(ms);
    return realTimeout(ms);
  }) as typeof AbortSignal.timeout;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  timeouts.length = 0;
  delete fakeEnv.OPENAI_API_KEY;
  delete fakeEnv.PULSAR_MODEL_STUB;
});

const URL = "https://api.openai.com/v1/chat/completions";

test("postCompletion posts the body as JSON to Chat Completions with the key and the signal it was given", async () => {
  const { postCompletion } = await import("./completions");
  stubFetch(() => new Response("{}"));
  const signal = AbortSignal.timeout(5_000);
  const body = { model: "m", messages: [{ role: "user", content: "hola" }] };

  const response = await postCompletion({ apiKey: "sk-test", body, signal });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json", authorization: "Bearer sk-test" });
  assert.equal(calls[0].init.body, JSON.stringify(body));
  assert.equal(calls[0].init.signal, signal);
});

const task = (name: string): DraftTask => ({
  name, month: "2026-10", estimate: null, note: null, noteSrc: [], src: [], week: null, rule: null, children: [],
});
const goal = (key: string, parent: string | null, name: string, tasks: DraftTask[] = []): DraftGoal => ({
  key, parent, name, horizon: "2027-10-01", measure: null, rhythm: null, note: null, noteSrc: [], src: [],
  phases: [], months: [], commitments: [], rules: [], tasks,
});
const holding: ImportDraft = { version: 2, goals: [goal("g", null, "Carrera", [task("Uno")]), goal("c", "g", "Caso")] };

test("the arrangement sends the same request as before and keeps its own 120 s limit", async () => {
  const { proposeMoves } = await import("@/lib/import/arrange");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  stubFetch(() => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"moves":[]}' } }] })));

  const result = await proposeMoves(holding, Date.now());

  assert.equal(result.status, "ok");
  assert.equal(calls[0].url, URL);
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json", authorization: "Bearer sk-test" });
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.max_completion_tokens, 8000);
  assert.ok(Math.abs(timeouts[0] - 120_000) < 1_000);
});

test("the import read sends the same request as before and keeps its own 240 s limit", async () => {
  const { readPlan } = await import("@/lib/import/model");
  fakeEnv.OPENAI_API_KEY = "sk-test";
  stubFetch(() => new Response("no", { status: 500 }));
  const quiet = mock.method(console, "error", () => {});

  await readPlan({ kind: "text", text: "# Plan" }, () => {});
  quiet.mock.restore();

  assert.equal(calls[0].url, URL);
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json", authorization: "Bearer sk-test" });
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.stream, true);
  assert.equal(timeouts[0], 240_000);
});

test("with a blank key, neither the import nor the arrangement reaches the network", async () => {
  const { readPlan } = await import("@/lib/import/model");
  const { proposeMoves } = await import("@/lib/import/arrange");
  stubFetch(() => new Response("{}"));
  fakeEnv.OPENAI_API_KEY = "";

  assert.deepEqual(await readPlan({ kind: "text", text: "# Plan" }, () => {}), { status: "failed" });
  assert.deepEqual(await proposeMoves(holding, Date.now()), { status: "none" });
  assert.equal(calls.length, 0);
});
