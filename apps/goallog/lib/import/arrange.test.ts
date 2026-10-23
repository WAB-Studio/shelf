import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import type { DraftGoal, DraftTask, ImportDraft } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const arrange = () => import("./arrange");
const proposeMoves = async (draft: ImportDraft) => (await arrange()).proposeMoves(draft, Date.now());
const arrangeWanted = async (draft: ImportDraft) => (await arrange()).arrangeWanted(draft);

const task = (name: string, over: Partial<DraftTask> = {}): DraftTask => ({
  name,
  month: "2026-10",
  estimate: null,
  note: null,
  noteSrc: [],
  src: [],
  week: null,
  rule: null,
  children: [],
  ...over,
});
const goal = (key: string, parent: string | null, name: string, tasks: DraftTask[] = [], over: Partial<DraftGoal> = {}): DraftGoal => ({
  key,
  parent,
  name,
  horizon: "2027-10-01",
  measure: null,
  rhythm: null,
  note: null,
  noteSrc: [],
  src: [],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks,
  ...over,
});
const draft = (...goals: DraftGoal[]): ImportDraft => ({ version: 2, goals });

// A general with three tasks, two pillars, and one goal inside a pillar.
const plan = () =>
  draft(
    goal("g", null, "Carrera", [task("Caso 1: wireframes"), task("Inglés: Anki"), task("Publicar el portafolio")]),
    goal("c1", "g", "Caso #1"),
    goal("en", "g", "Inglés B1", [task("Ya aquí")]),
    goal("c1a", "c1", "Caso #1 · pruebas"),
  );

const realFetch = globalThis.fetch;
const calls: { url: string; body: Record<string, unknown> }[] = [];

function answers(content: unknown, usage: object | undefined = { prompt_tokens: 900, completion_tokens: 120 }, finish = "stop") {
  calls.length = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finish }], usage }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
  delete fakeEnv.PULSAR_MODEL_STUB;
  calls.length = 0;
});

test("only a goal that holds goals and tasks is asked about", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  assert.equal(await arrangeWanted(plan()), true);
  assert.equal(await arrangeWanted(draft(goal("a", null, "Sola", [task("x")]))), false);
  assert.equal(await arrangeWanted(draft(goal("a", null, "Vacía"), goal("b", "a", "Hija", [task("x")]))), false);
});

test("with no key, or a test seam standing in for the model, nothing is asked", async () => {
  assert.equal(await arrangeWanted(plan()), false);
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  fakeEnv.PULSAR_MODEL_STUB = "fail";
  assert.equal(await arrangeWanted(plan()), false);
});

test("the call carries the holder's tasks and every goal below it, and asks for strict JSON from gpt-5.5", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [] });
  await proposeMoves(plan());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  const body = calls[0].body as { model: string; response_format: { json_schema: { strict: boolean } }; messages: { content: string }[] };
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.response_format.json_schema.strict, true);
  const sent = JSON.parse(body.messages[1].content) as { holders: { key: string; tasks: { i: number; name: string }[]; goals: { key: string; parent: string }[] }[] };
  assert.deepEqual(sent.holders.map((h) => h.key), ["g"]);
  assert.deepEqual(sent.holders[0].tasks.map((t) => [t.i, t.name]), [[0, "Caso 1: wireframes"], [1, "Inglés: Anki"], [2, "Publicar el portafolio"]]);
  assert.deepEqual(sent.holders[0].goals.map((g) => [g.key, g.parent]), [["c1", "g"], ["en", "g"], ["c1a", "c1"]]);
});

test("the moves the model proposes come back with the tokens the call spent", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [{ holder: "g", task: 0, to: "c1" }, { holder: "g", task: 1, to: "en" }] });
  const result = await proposeMoves(plan());
  assert.deepEqual(result, { status: "ok", moves: [{ from: 0, task: 0, to: 1 }, { from: 0, task: 1, to: 2 }], usage: { input: 900, output: 120 } });
});

test("a move the draft cannot hold is dropped: a goal not below, a task out of range, a task twice", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({
    moves: [
      { holder: "g", task: 0, to: "g" },
      { holder: "g", task: 9, to: "c1" },
      { holder: "g", task: 1, to: "nadie" },
      { holder: "en", task: 0, to: "c1" },
      { holder: "g", task: 2, to: "c1a" },
      { holder: "g", task: 2, to: "en" },
    ],
  });
  const result = await proposeMoves(plan());
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.moves, [{ from: 0, task: 2, to: 3 }]);
});

test("an answer that is not the shape is invalid, a failed request is failed; neither moves anything", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [{ holder: "g", task: "cero", to: "c1" }] });
  assert.equal((await proposeMoves(plan())).status, "invalid");
  answers("no es json");
  assert.equal((await proposeMoves(plan())).status, "failed");
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  assert.deepEqual(await proposeMoves(plan()), { status: "failed" });
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  assert.deepEqual(await proposeMoves(plan()), { status: "failed" });
});

test("an answer cut at the token ceiling is failed and still reports its tokens", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers('{"moves":[', { prompt_tokens: 50, completion_tokens: 8000 }, "length");
  assert.deepEqual(await proposeMoves(plan()), { status: "failed", usage: { input: 50, output: 8000 } });
});

test("a draft with nothing to ask is never sent", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [] });
  assert.deepEqual(await proposeMoves(draft(goal("a", null, "Sola", [task("x")]))), { status: "none" });
  assert.equal(calls.length, 0);
});

test("a move is a correction at the task's own place, naming where it went", async () => {
  const cs = (await arrange()).moveCorrections(plan(), [{ from: 0, task: 1, to: 2 }, { from: 0, task: 0, to: 1 }]);
  assert.deepEqual(
    cs.map((c) => [c.id, c.at, c.code, c.said, c.proposed, c.values, c.declined]),
    [
      ["goals.0.tasks.0:taskMoved", "goals.0.tasks.0", "taskMoved", "Carrera", "Caso #1", { to: "c1", name: "Caso 1: wireframes" }, "keepsPlan"],
      ["goals.0.tasks.1:taskMoved", "goals.0.tasks.1", "taskMoved", "Carrera", "Inglés B1", { to: "en", name: "Inglés: Anki" }, "keepsPlan"],
    ],
  );
});

test("a task number equal to the holder's task count is dropped; the last real one is kept", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [{ holder: "g", task: 3, to: "c1" }, { holder: "g", task: -1, to: "c1" }, { holder: "g", task: 2, to: "c1" }] });
  const result = await proposeMoves(plan());
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.moves, [{ from: 0, task: 2, to: 1 }]);
});

test("a goal that names itself as its parent is not below itself: no task moves into it", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [{ holder: "a", task: 0, to: "a" }] });
  const loop = draft(goal("a", "a", "Ciclo", [task("x")]));
  const result = await proposeMoves(loop);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.moves, []);
});

test("a goal written before its parent is not below it: no task moves into it", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  answers({ moves: [{ holder: "y", task: 0, to: "x" }] });
  const result = await proposeMoves(draft(goal("x", "y", "Antes"), goal("y", null, "Después", [task("t")])));
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.moves, []);
  const sent = JSON.parse((calls[0].body as { messages: { content: string }[] }).messages[1].content) as { holders: { goals: unknown[] }[] };
  assert.deepEqual(sent.holders.map((h) => h.goals), [[]]);
});

test("a goal four levels under the holder is below it; five levels is not", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  const deep = draft(
    goal("g0", null, "Raíz", [task("a"), task("b")]),
    goal("g1", "g0", "N1"),
    goal("g2", "g1", "N2"),
    goal("g3", "g2", "N3"),
    goal("g4", "g3", "N4"),
    goal("g5", "g4", "N5"),
  );
  answers({ moves: [{ holder: "g0", task: 0, to: "g4" }, { holder: "g0", task: 1, to: "g5" }] });
  const result = await proposeMoves(deep);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.moves, [{ from: 0, task: 0, to: 4 }]);
  const sent = JSON.parse((calls[0].body as { messages: { content: string }[] }).messages[1].content) as { holders: { goals: { key: string }[] }[] };
  assert.deepEqual(sent.holders[0].goals.map((g) => g.key), ["g1", "g2", "g3", "g4"]);
});

test("a refusal from the model is failed even when it carries well-formed moves", async () => {
  fakeEnv.OPENAI_API_KEY = "sk-never-sent";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ moves: [{ holder: "g", task: 0, to: "c1" }] }), refusal: "No puedo ayudar con eso." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  assert.deepEqual(await proposeMoves(plan()), { status: "failed", usage: { input: 10, output: 2 } });
});
