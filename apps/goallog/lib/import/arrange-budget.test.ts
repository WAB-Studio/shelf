// M14: the arrange pass takes only the time the 300 s function has left. It gets
// min(120 s, start + 290 s - now - 10 s) and is skipped under 15 s. The start is the second argument;
// the clock is a fake Date, the model a stub `fetch`.
import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import type { DraftGoal, DraftTask, ImportDraft } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const task = (name: string): DraftTask => ({ name, month: "2026-10", estimate: null, note: null, noteSrc: [], src: [], week: null, rule: null, children: [] });
const goal = (key: string, parent: string | null, name: string, tasks: DraftTask[] = []): DraftGoal => ({
  key, parent, name, horizon: "2027-10-01", measure: null, rhythm: null, note: null, noteSrc: [], src: [],
  phases: [], months: [], commitments: [], rules: [], tasks,
});
const plan = (): ImportDraft => ({
  version: 2,
  goals: [goal("g", null, "Carrera", [task("Caso 1: wireframes")]), goal("c1", "g", "Caso #1")],
});

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const realFetch = globalThis.fetch;
let fetched = 0;

function stubModel() {
  fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ moves: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }) as typeof fetch;
}

// `proposeMoves` at `elapsed` seconds after the request began.
async function proposedAt(elapsed: number) {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  stubModel();
  mock.timers.enable({ apis: ["Date"], now: START + elapsed * 1000 });
  const { proposeMoves } = await import("./arrange");
  return (proposeMoves as (draft: ImportDraft, startedAt: number) => ReturnType<typeof proposeMoves>)(plan(), START);
}

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
});

test("early in the request the pass runs", async () => {
  assert.equal((await proposedAt(100)).status, "ok");
  assert.equal(fetched, 1);
});

test("at 285 s elapsed the pass is skipped and asks nothing", async () => {
  const reading = await proposedAt(285);
  assert.equal(reading.status, "none");
  assert.equal(fetched, 0);
});

test("with 15 s left the pass runs; with 14 s left it is skipped", async () => {
  assert.equal((await proposedAt(265)).status, "ok");
  assert.equal(fetched, 1);
  mock.timers.reset();
  assert.equal((await proposedAt(266)).status, "none");
  assert.equal(fetched, 0);
});

test("past the 290 s the function allows, the pass is skipped", async () => {
  assert.equal((await proposedAt(295)).status, "none");
  assert.equal(fetched, 0);
});

// Two imports on one server: each pass is judged by its own request's start, whatever read began since.
test("two interleaved requests each keep their own start", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  const { readPlan } = await import("./model");
  const { proposeMoves } = await import("./arrange");
  const stream = () =>
    new Response(
      new Blob([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"goals":[]}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`]).stream(),
    );
  fetched = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    if (JSON.parse(init.body as string).stream) return stream();
    fetched += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ moves: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }) as typeof fetch;

  mock.timers.enable({ apis: ["Date"], now: START });
  await readPlan({ kind: "text", text: "a" }, () => {});
  const early = START;
  mock.timers.setTime(START + 200_000);
  await readPlan({ kind: "text", text: "b" }, () => {});
  const late = START + 200_000;
  mock.timers.setTime(START + 285_000);

  const [first, second] = await Promise.all([proposeMoves(plan(), early), proposeMoves(plan(), late)]);
  assert.equal(first.status, "none", "the early request has no time left");
  assert.equal(second.status, "ok", "the late request still has 195 s");
  assert.equal(fetched, 1);
});
