// RL-60: a database error behind a paid route is absence, never a 500. The
// word, unlisted and notes routes answer 204; translate falls to MyMemory.
// Every database function, the model and the provider are stand-ins: no
// `reading.*` row is read or written and nothing is spent.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const here = (path: string) => new URL(path, import.meta.url).href;

const boom = async (): Promise<never> => {
  throw new Error("database unreachable");
};

const state = {
  readCachedText: boom as () => Promise<unknown>,
  readCachedAnswer: boom as () => Promise<unknown>,
  readCachedNotes: boom as () => Promise<unknown>,
  claimClientCall: boom as () => Promise<boolean>,
  claimDailyCall: boom as () => Promise<boolean>,
  providerCalls: [] as string[],
  modelCalls: 0,
  writeCachedText: (async () => {}) as () => Promise<void>,
  markTranslationsAsked: (async () => {}) as () => Promise<void>,
  writeCachedAnswer: (async () => {}) as () => Promise<void>,
  writeCachedNotes: (async () => {}) as () => Promise<void>,
  generated: false,
};

const env = {
  OPENAI_API_KEY: "sk-test",
  WORD_TEXT_DAILY_CALL_CAP: 10,
  WORD_TEXT_DAILY_CLIENT_CAP: 5,
  WORD_UNLISTED_DAILY_CLIENT_CAP: 5,
  PHRASE_NOTES_DAILY_CALL_CAP: 10,
  PHRASE_NOTES_DAILY_CLIENT_CAP: 5,
  TRANSLATE_DAILY_CLIENT_CAP: 5,
};

const MYMEMORY_REPLY = { responseStatus: 200, responseData: { translatedText: "el gato" } };

const providerFetch = async (url: string) => {
  state.providerCalls.push(url);
  if (url.includes("mymemory")) return { json: async () => MYMEMORY_REPLY };
  state.modelCalls += 1;
  return null;
};

// `server-only` throws outside Next and is not installed as a package: a stub
// package on NODE_PATH lets the routes' first import load.
const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

mock.module(here("../lib/env.ts"), { namedExports: { env } });
mock.module(here("../lib/provider/fetch.ts"), { namedExports: { providerFetch } });
mock.module(here("../lib/word/client-budget.ts"), {
  namedExports: {
    claimClientCall: (...args: unknown[]) => state.claimClientCall.apply(null, args as []),
    clientKey: () => "caller",
    scopedClientKey: () => "caller",
  },
});
mock.module(here("../lib/word/spend.ts"), {
  namedExports: { claimDailyCall: (...args: unknown[]) => state.claimDailyCall.apply(null, args as []) },
});
mock.module(here("../lib/word/dictionary-index.ts"), { namedExports: { loadDictionaryIndex: () => ({}) } });
mock.module(here("../lib/dictionary/index-build.ts"), {
  namedExports: { groupFor: () => ({ headword: "cat", senses: [{ definition: null, translations: [] }] }) },
});
mock.module(here("../lib/dictionary/lookup.ts"), {
  namedExports: { lookupWord: () => ({ exact: null, viaInflection: [], correction: [] }) },
});
mock.module(here("../lib/word/model.ts"), {
  namedExports: {
    MODEL_NAME: "stub",
    generateWordText: async () => {
      state.modelCalls += 1;
      return state.generated ? { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: ["gato"] } : null;
    },
  },
});
mock.module(here("../lib/word/unlisted-model.ts"), {
  namedExports: {
    generateUnlistedAnswer: async () => {
      state.modelCalls += 1;
      return state.generated
        ? { translations: ["zorblax"], definition: null, example: { en: "A zorblax.", es: "Un zorblax." } }
        : null;
    },
  },
});
mock.module(here("../lib/phrase/notes-model.ts"), {
  namedExports: {
    NOTES_MODEL_NAME: "stub",
    generateNotes: async () => {
      state.modelCalls += 1;
      return state.generated ? [{ term: "cat", note: "gato" }] : null;
    },
  },
});
mock.module(here("../lib/word/text-cache.ts"), {
  namedExports: {
    readCachedText: () => state.readCachedText(),
    writeCachedText: () => state.writeCachedText(),
    markTranslationsAsked: () => state.markTranslationsAsked(),
    translationsWereAnswered: () => false,
  },
});
mock.module(here("../lib/word/unlisted-cache.ts"), {
  namedExports: { readCachedAnswer: () => state.readCachedAnswer(), writeCachedAnswer: () => state.writeCachedAnswer() },
});
mock.module(here("../lib/phrase/notes-cache.ts"), {
  namedExports: {
    phraseHash: () => "hash",
    readCachedNotes: () => state.readCachedNotes(),
    writeCachedNotes: () => state.writeCachedNotes(),
  },
});

function post(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TEXT = { headword: "cat", needDefinition: true };
const UNLISTED = { word: "zorblax" };
const NOTES = { source: "the cat sat down", translation: "el gato se sento" };

let logged: string[] = [];

beforeEach(() => {
  state.readCachedText = boom;
  state.readCachedAnswer = boom;
  state.readCachedNotes = boom;
  state.claimClientCall = boom;
  state.claimDailyCall = boom;
  state.providerCalls = [];
  state.modelCalls = 0;
  state.writeCachedText = boom;
  state.markTranslationsAsked = boom;
  state.writeCachedAnswer = boom;
  state.writeCachedNotes = boom;
  state.generated = true;
  logged = [];
  mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

function assertLoggedOnce(route: string) {
  assert.equal(logged.length, 1, `one log line, got ${logged.length}`);
  assert.ok(logged[0].includes(route), logged[0]);
  assert.ok(logged[0].includes("database unreachable"), logged[0]);
}

test("translate: a failing daily claim falls to MyMemory", async () => {
  state.claimClientCall = async () => true;
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post({ text: "the cat" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "el gato", origin: "network" });
  assert.equal(state.providerCalls.length, 1);
  assert.ok(state.providerCalls[0].includes("mymemory"));
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/translate");
});

test("translate: a failing caller claim is answered, never thrown", async () => {
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post({ text: "the cat" }));
  assert.equal(response.status, 502);
  assert.equal(state.providerCalls.length, 0);
  assertLoggedOnce("api/translate");
});

test("word/text: a failing cache read answers 204", async () => {
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/word/text");
});

test("word/text: a failing claim on a cache miss answers 204", async () => {
  state.readCachedText = async () => null;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/word/text");
});

test("word/text: a failing claim on enrichment keeps the cached answer", async () => {
  state.readCachedText = async () => ({
    definition: "a pet",
    example: { en: "A cat.", es: "Un gato." },
    translations: null,
    translationsAsked: false,
  });
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 200);
  assert.equal(state.modelCalls, 0);
});

test("word/unlisted: a failing cache read answers 204", async () => {
  const { POST } = await import("../app/api/word/unlisted/route");
  const response = await POST(post(UNLISTED));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/word/unlisted");
});

test("word/unlisted: a failing caller claim answers 204", async () => {
  state.readCachedAnswer = async () => null;
  const { POST } = await import("../app/api/word/unlisted/route");
  const response = await POST(post(UNLISTED));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/word/unlisted");
});

test("word/unlisted: a failing daily claim answers 204", async () => {
  state.readCachedAnswer = async () => null;
  state.claimClientCall = async () => true;
  const { POST } = await import("../app/api/word/unlisted/route");
  const response = await POST(post(UNLISTED));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/word/unlisted");
});

test("phrase/notes: a failing cache read answers 204", async () => {
  const { POST } = await import("../app/api/phrase/notes/route");
  const response = await POST(post(NOTES));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/phrase/notes");
});

test("phrase/notes: a failing caller claim answers 204", async () => {
  state.readCachedNotes = async () => null;
  const { POST } = await import("../app/api/phrase/notes/route");
  const response = await POST(post(NOTES));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/phrase/notes");
});

test("phrase/notes: a failing daily claim answers 204", async () => {
  state.readCachedNotes = async () => null;
  state.claimClientCall = async () => true;
  const { POST } = await import("../app/api/phrase/notes/route");
  const response = await POST(post(NOTES));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assertLoggedOnce("api/phrase/notes");
});

test("word/text: a failing cache write still answers the paid text", async () => {
  state.readCachedText = async () => null;
  state.claimClientCall = async () => true;
  state.claimDailyCall = async () => true;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { example: { en: string } }).example.en, "A cat.");
  assertLoggedOnce("api/word/text");
});

test("word/text: a failing enrichment mark still answers the cached text", async () => {
  state.readCachedText = async () => ({
    definition: "a pet",
    example: { en: "A cat.", es: "Un gato." },
    translations: null,
    translationsAsked: false,
  });
  state.claimClientCall = async () => true;
  state.claimDailyCall = async () => true;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { translations: string[] }).translations, ["gato"]);
  assertLoggedOnce("api/word/text");
});

test("word/unlisted: a failing cache write still answers the paid text", async () => {
  state.readCachedAnswer = async () => null;
  state.claimClientCall = async () => true;
  state.claimDailyCall = async () => true;
  const { POST } = await import("../app/api/word/unlisted/route");
  const response = await POST(post(UNLISTED));
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { translations: string[] }).translations, ["zorblax"]);
  assertLoggedOnce("api/word/unlisted");
});

test("phrase/notes: a failing cache write still answers the paid notes", async () => {
  state.readCachedNotes = async () => null;
  state.claimClientCall = async () => true;
  state.claimDailyCall = async () => true;
  const { POST } = await import("../app/api/phrase/notes/route");
  const response = await POST(post(NOTES));
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { notes: unknown[] }).notes, [{ term: "cat", note: "gato" }]);
  assertLoggedOnce("api/phrase/notes");
});
