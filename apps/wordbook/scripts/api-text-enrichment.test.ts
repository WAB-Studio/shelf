// The paid word route's enrichment: what it asks the model for, and what it
// marks or stores afterwards. Every claim, cache and model is a stand-in that
// records its calls: nothing is read, written or spent.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

type Group = { headword: string; senses: { definition: string | null; translations: string[]; pos?: string }[] };

const THIN: Group = { headword: "cat", senses: [{ definition: null, translations: [] }] };
// Thin by sense count; one sense carries a dictionary definition, one does not.
const MIXED: Group = {
  headword: "cat",
  senses: [
    { definition: "a pet", translations: [] },
    { definition: null, translations: [] },
  ],
};

type Generated = { definition: string; example: { en: string; es: string }; translations: string[] | null };

const state = {
  group: THIN as Group,
  cached: null as unknown,
  generated: null as Generated | null,
  modelArgs: [] as unknown[][],
  marks: [] as unknown[][],
  writes: [] as unknown[][],
};

const env = { OPENAI_API_KEY: "sk-test", WORD_TEXT_DAILY_CALL_CAP: 10, WORD_TEXT_DAILY_CLIENT_CAP: 5 };

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

mock.module(here("../lib/env.ts"), { namedExports: { env } });
mock.module(here("../lib/word/client-budget.ts"), {
  namedExports: { claimClientCall: async () => true, clientKey: () => "ck-1", scopedClientKey: () => "ck-1" },
});
mock.module(here("../lib/word/caller-share.ts"), { namedExports: { claimCallerShare: async () => true } });
mock.module(here("../lib/word/spend.ts"), { namedExports: { claimDailyCall: async () => true } });
mock.module(here("../lib/word/dictionary-index.ts"), { namedExports: { loadDictionaryIndex: () => ({}) } });
mock.module(here("../lib/dictionary/index-build.ts"), { namedExports: { groupFor: () => state.group } });
mock.module(here("../lib/word/model.ts"), {
  namedExports: {
    MODEL_NAME: "stub",
    generateWordText: async (...args: unknown[]) => {
      state.modelArgs.push(args);
      return state.generated;
    },
  },
});
mock.module(here("../lib/word/text-cache.ts"), {
  namedExports: {
    readCachedText: async () => state.cached,
    writeCachedText: async (...args: unknown[]) => void state.writes.push(args),
    markTranslationsAsked: async (...args: unknown[]) => void state.marks.push(args),
    translationsWereAnswered: (translations: readonly string[] | null) => translations !== null,
  },
});

const real = { warn: console.warn, error: console.error };

beforeEach(() => {
  console.warn = () => {};
  console.error = () => {};
  Object.assign(state, {
    group: THIN,
    cached: null,
    generated: { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: ["gato"] },
    modelArgs: [],
    marks: [],
    writes: [],
  });
});
afterEach(() => Object.assign(console, real));

async function ask(needDefinition: boolean): Promise<Response> {
  const { POST } = await import("../app/api/word/text/route");
  return POST(
    new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headword: "cat", needDefinition }),
    }),
  );
}

test("a cached thin row never asked is enriched once and marked asked with the model's translations", async () => {
  state.cached = { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: null, translationsAsked: false };
  const response = await ask(true);
  assert.equal(response.status, 200);
  assert.equal(state.modelArgs.length, 1);
  assert.deepEqual(state.marks, [["cat", ["gato"]]]);
  assert.deepEqual((await response.json()).translations, ["gato"]);
});

test("a cached thin row the model leaves null is marked with null, not skipped", async () => {
  state.cached = { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: null, translationsAsked: false };
  state.generated = { ...state.generated!, translations: null };
  await ask(true);
  assert.deepEqual(state.marks, [["cat", null]]);
});

test("a cold thin word the model answers is closed (asked = true), even with []", async () => {
  state.generated = { ...state.generated!, translations: [] };
  await ask(true);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].slice(5), [[], true]);
});

test("a cold thin word the model leaves null stays open (asked = false)", async () => {
  state.generated = { ...state.generated!, translations: null };
  await ask(true);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].slice(5), [null, false]);
});

test("one dictionary definition in the group means the model is not asked for a definition", async () => {
  state.group = MIXED;
  const response = await ask(true);
  assert.equal(state.modelArgs[0][1], false);
  assert.equal(state.writes[0][2], null);
  assert.equal((await response.json()).definition, null);
});

test("a definition-less entry is not asked for one when the caller does not need it", async () => {
  state.group = THIN;
  await ask(false);
  assert.equal(state.modelArgs[0][1], false);
  assert.equal(state.writes[0][2], null);
});

test("a definition-less entry the caller needs is asked for one and stores it", async () => {
  state.group = THIN;
  await ask(true);
  assert.equal(state.modelArgs[0][1], true);
  assert.equal(state.writes[0][2], "a pet");
});
