// M14: a long plan whose whole answer is cut by `length` is read again per top-level section,
// not failed whole. The model is a stub `fetch`; nothing is spent.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import type { RawDraft } from "./draft";

const fakeEnv: { OPENAI_API_KEY?: string; PULSAR_MODEL_STUB?: string } = {};
mock.module("@/lib/env", { namedExports: { env: fakeEnv } });

const spent = { reads: 0, followUps: 0 };
mock.module("./spend", {
  namedExports: {
    claimModelCall: async () => {
      spent.reads += 1;
      return { id: "read" };
    },
    claimFollowUp: async () => {
      spent.followUps += 1;
      return { id: "follow-up" };
    },
    settleModelCall: async () => true,
    appCapReached: async () => false,
    MODEL_CALLS_DAILY_CAP: 10,
    CHAT_CALLS_DAILY_CAP: 50,
    FOLLOW_UP_SUFFIX: "/arrange",
  },
});

const realFetch = globalThis.fetch;
type Call = { numbered: string[]; first: number; heading: string };
const calls: Call[] = [];
let cutSections = new Set<string>();

const goalAt = (name: string, line: number): RawDraft["goals"][number] => ({
  key: name,
  parent: null,
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

function stream(content: string, finish: string): Response {
  const events = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new Blob([events.join("")]).stream(), { headers: { "content-type": "text/event-stream" } });
}

// The whole read is cut. A section read answers one goal named after its heading, whose `src` is the
// first line the model was shown: absolute whatever way the app numbers the section it sends.
function install(totalLines: number) {
  calls.length = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const text: string = body.messages[1].content[0].text;
    const numbered = text.split("\n");
    const first = Number(numbered[0].split("|")[0]);
    const heading = numbered.map((l) => l.slice(l.indexOf("|") + 1)).find((l) => /^#\s/.test(l))?.replace(/^#\s+/, "") ?? "";
    calls.push({ numbered, first, heading });
    if (numbered.length >= totalLines) return stream('{"goals":[{"key":"cut', "length");
    if (cutSections.has(heading)) return stream('{"goals":[{"key":"cut', "length");
    return stream(JSON.stringify({ goals: [goalAt(heading, first)] }), "stop");
  }) as typeof fetch;
}

beforeEach(() => {
  fakeEnv.OPENAI_API_KEY = "sk-test";
  spent.reads = 0;
  spent.followUps = 0;
  cutSections = new Set();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete fakeEnv.OPENAI_API_KEY;
  delete fakeEnv.PULSAR_MODEL_STUB;
});

// Three top-level sections of 200 lines each, with deeper headings inside that open no section.
function roadmap(sections = ["Primer trimestre", "Segundo trimestre", "Cuarto trimestre"], size = 200): string {
  return sections
    .flatMap((title) => [`# ${title}`, ...Array.from({ length: size - 1 }, (_, i) => (i % 50 === 25 ? `## Semana ${i}` : `- tarea ${title} ${i}`))])
    .join("\n");
}
const read = async (text: string) => (await import("./model")).readPlan({ kind: "text", text }, () => {});
const withoutRaw = (result: object) => JSON.stringify({ ...result, raw: undefined, source: undefined, usage: undefined });

test("a 600-line roadmap whose answer is cut by length is read again per section, and the goals of every section come back", async () => {
  install(600);
  const result = await read(roadmap());

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.raw.goals.map((g) => g.name), ["Primer trimestre", "Segundo trimestre", "Cuarto trimestre"]);
  assert.equal(calls.length, 4, "the whole read, then one per section");
  assert.equal(calls[0].numbered.length, 600);
  assert.deepEqual(calls.slice(1).map((c) => c.numbered.length), [200, 200, 200]);
});

test("each goal's src stays in the plan's absolute lines", async () => {
  install(600);
  const result = await read(roadmap());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.raw.goals.map((g) => g.src[0].from), [1, 201, 401]);
  assert.equal(result.source.kind, "lines");
  assert.equal(result.source.lines?.length, 600);
});

test("a section cut again is left out with its reason and the others are kept", async () => {
  install(600);
  cutSections = new Set(["Segundo trimestre"]);
  const result = await read(roadmap());

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.raw.goals.map((g) => g.name), ["Primer trimestre", "Cuarto trimestre"]);
  assert.match(withoutRaw(result), /Segundo trimestre/, "the reading says which section was left out");
});

test("every section cut again leaves nothing to import: failed, as a cut whole read is today", async () => {
  install(600);
  cutSections = new Set(["Primer trimestre", "Segundo trimestre", "Cuarto trimestre"]);
  assert.equal((await read(roadmap())).status, "failed");
});

test("the split spends no read claim and at most one follow-up per section", async () => {
  install(600);
  await read(roadmap());
  assert.equal(spent.reads, 0, "the read's one claim is the caller's");
  assert.ok(spent.followUps >= 1 && spent.followUps <= 3, `follow-ups: ${spent.followUps}`);
});

test("a cut read of 300 lines or fewer is not split: it fails as before, in one call", async () => {
  install(300);
  const result = await read(roadmap(["Uno", "Dos", "Tres"], 100));
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 1);
  assert.equal(spent.followUps, 0);
});

test("a cut read of over 300 lines with no heading is not split", async () => {
  install(600);
  const result = await read(Array.from({ length: 600 }, (_, i) => `- tarea ${i}`).join("\n"));
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 1);
});

test("a read that was not cut is not read again", async () => {
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push({ numbered: [], first: 1, heading: String(init.body).length ? "x" : "" });
    return stream(JSON.stringify({ goals: [goalAt("Todo", 1)] }), "stop");
  }) as typeof fetch;
  calls.length = 0;
  const result = await read(roadmap());
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(spent.followUps, 0);
});
