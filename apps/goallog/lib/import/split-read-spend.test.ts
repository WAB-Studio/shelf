// M14, section read: what the person and the spend count owe each other when a long plan's whole
// answer is cut and the app reads it again by section. The model is a stub `fetch`; the spend
// module is a recorder; the clock is a fake Date. Nothing is spent.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import type { RawDraft } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

type Settle = { id: string; outcome: string; inputTokens: number; outputTokens: number };
const spent = { reads: 0, followUps: 0, settles: [] as Settle[], capped: false };
mock.module("./spend", {
  namedExports: {
    claimModelCall: async () => {
      spent.reads += 1;
      return { id: "read" };
    },
    claimFollowUp: async () => {
      spent.followUps += 1;
      return spent.capped ? null : { id: "follow-up" };
    },
    settleModelCall: async (id: string, result: { outcome: string; inputTokens: number; outputTokens: number }) => {
      spent.settles.push({ id, ...result });
      return true;
    },
    appCapReached: async () => false,
    MODEL_CALLS_DAILY_CAP: 10,
    CHAT_CALLS_DAILY_CAP: 50,
    FOLLOW_UP_SUFFIX: "/arrange",
  },
});

const realFetch = globalThis.fetch;
type Call = { first: number; length: number; heading: string };
const calls: Call[] = [];
// What a section read answers, by the heading it was shown; the whole read is always cut.
type Answer = { goals: RawDraft["goals"]; finish: string } | "refusal";
let answerFor: (heading: string, first: number) => Answer = () => ({ goals: [], finish: "stop" });
let afterWholeRead: () => void = () => {};

const goal = (key: string, name: string, parent: string | null, line: number): RawDraft["goals"][number] => ({
  key,
  parent,
  name,
  horizon: null,
  measure: null,
  rate: null,
  noteSrc: [],
  noteText: null,
  src: [{ from: line, to: line }],
  phases: [],
  months: [],
  commitments: [],
  rules: [],
  tasks: [],
});

function sse(content: string, finish: string, refusal = false): Response {
  const delta = refusal ? { refusal: "no" } : { content };
  const events = [
    { choices: [{ delta }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
  ];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new Blob([body]).stream(), { headers: { "content-type": "text/event-stream" } });
}

function install(totalLines: number) {
  calls.length = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const text: string = JSON.parse(init.body as string).messages[1].content[0].text;
    const numbered = text.split("\n");
    const first = Number(numbered[0].split("|")[0]);
    const heading = numbered.map((l) => l.slice(l.indexOf("|") + 1)).find((l) => /^#\s/.test(l))?.replace(/^#\s+/, "") ?? "";
    calls.push({ first, length: numbered.length, heading });
    if (numbered.length >= totalLines) {
      afterWholeRead();
      return sse('{"goals":[{"key":"cut', "length");
    }
    const answer = answerFor(heading, first);
    if (answer === "refusal") return sse("", "stop", true);
    return sse(JSON.stringify({ goals: answer.goals }), answer.finish);
  }) as typeof fetch;
}

beforeEach(() => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  spent.reads = 0;
  spent.followUps = 0;
  spent.settles = [];
  spent.capped = false;
  afterWholeRead = () => {};
  answerFor = (heading, first) => ({ goals: [goal("g1", heading, null, first)], finish: "stop" });
});
afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
});

const block = (title: string, size: number) => [`# ${title}`, ...Array.from({ length: size - 1 }, (_, i) => `- tarea ${title} ${i}`)];
const roadmap = (titles = ["Primer trimestre", "Segundo trimestre", "Cuarto trimestre"], size = 200, preamble: string[] = []) =>
  [...preamble, ...titles.flatMap((t) => block(t, size))].join("\n");
const read = async (text: string) => (await import("./model")).readPlan({ kind: "text", text }, () => {});

test("a capped person's long plan pays for no section read: the follow-up claim is refused, the model is asked once", async () => {
  install(600);
  spent.capped = true;
  const result = await read(roadmap());
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 1, "only the whole read went to the model");
  assert.deepEqual(spent.settles, [], "no claim, nothing to settle");
});

test("the spend count: sections that came back are settled ok, with the tokens of every read", async () => {
  install(600);
  await read(roadmap());
  assert.equal(spent.settles.length, 1);
  assert.deepEqual(spent.settles[0], { id: "follow-up", outcome: "ok", inputTokens: 30, outputTokens: 60 });
});

test("the spend count: when no section returned a goal the claim is settled failed, never ok", async () => {
  install(600);
  answerFor = () => ({ goals: [], finish: "length" });
  const result = await read(roadmap());
  assert.equal(result.status, "failed");
  assert.equal(spent.settles.length, 1);
  assert.equal(spent.settles[0].outcome, "failed");
  assert.equal(spent.settles[0].inputTokens, 30, "the cut reads were paid for and are counted");
});

test("the spend count: sections that all answer an empty plan are settled failed too", async () => {
  install(600);
  answerFor = () => ({ goals: [], finish: "stop" });
  assert.equal((await read(roadmap())).status, "failed");
  assert.equal(spent.settles[0].outcome, "failed");
});

test("two sections that both call their goal g1 stay two goals, and each sub-goal sits under its own section's parent", async () => {
  install(600);
  answerFor = (heading, first) => ({
    finish: "stop",
    goals: [goal("g1", `Padre ${heading}`, null, first), goal("g2", `Hijo ${heading}`, "g1", first + 1)],
  });
  const result = await read(roadmap(["Alfa", "Beta"], 300));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const goals = result.raw.goals;
  assert.equal(goals.length, 4);
  assert.equal(new Set(goals.map((g) => g.key)).size, 4, "no two goals share a key");
  for (const child of goals.filter((g) => g.name.startsWith("Hijo"))) {
    const parent = goals.filter((g) => g.key === child.parent);
    assert.equal(parent.length, 1, "the parent key names exactly one goal");
    assert.equal(parent[0].name, child.name.replace("Hijo", "Padre"));
  }
});

test("lines above the first heading belong to the first section and reach the model", async () => {
  install(605);
  const preamble = ["Mi plan de carrera", "escrito en 2026", "", "", ""];
  const result = await read(roadmap(["Alfa", "Beta", "Gamma"], 200, preamble));
  assert.equal(result.status, "ok");
  assert.equal(calls[1].first, 1, "the first section starts at line 1");
  assert.equal(calls[1].length, 205);
  assert.equal(calls[2].first, 206);
  assert.equal(calls[3].first, 406);
  const covered = calls.slice(1).reduce((n, c) => n + c.length, 0);
  assert.equal(covered, 605, "every line of the plan is shown to some section read");
});

test("a section the model cut is left out and named, even when what it wrote before the cut is valid JSON", async () => {
  install(600);
  answerFor = (heading, first) => ({ goals: [goal("g1", heading, null, first)], finish: heading === "Segundo trimestre" ? "length" : "stop" });
  const result = await read(roadmap());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.raw.goals.map((g) => g.name), ["Primer trimestre", "Cuarto trimestre"]);
  assert.deepEqual(result.leftOut, [{ heading: "Segundo trimestre", from: 201, to: 400 }]);
});

test("a section the model refused is left out and named", async () => {
  install(600);
  answerFor = (heading, first) => (heading === "Cuarto trimestre" ? "refusal" : { goals: [goal("g1", heading, null, first)], finish: "stop" });
  const result = await read(roadmap());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.leftOut, [{ heading: "Cuarto trimestre", from: 401, to: 600 }]);
});

test("a cut read of over 300 lines with a single heading is not split: the one section would be the read that was cut", async () => {
  install(600);
  const result = await read(roadmap(["Solo"], 600));
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 1);
  assert.equal(spent.followUps, 0);
});

// The second read starts only with 15 s of the function's 290 s budget left after a 10 s margin.
async function readAfter(elapsedSeconds: number) {
  install(600);
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 18, 12, 0, 0) });
  afterWholeRead = () => mock.timers.tick(elapsedSeconds * 1000);
  return read(roadmap());
}

test("the whole read took 280 s: no second read starts, no claim is made, the plan fails named as before", async () => {
  const result = await readAfter(280);
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 1, "no section read with the time gone");
  assert.equal(spent.followUps, 0);
});

test("the whole read took 264 s: 16 s are left and the sections are read", async () => {
  const result = await readAfter(264);
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 4);
});
