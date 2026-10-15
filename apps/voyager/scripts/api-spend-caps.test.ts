// RL-35, RL-41, RL-42, RL-44, RL-60: the paid routes spend only inside the
// caps. A caller nobody can charge, a caller over their own cap and a day
// already spent each answer absence (204; 429 for translate's caller cap) and
// the model is never reached. Every claim, the model and the provider are
// stand-ins that count calls: nothing is read, written or spent.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

type Group = { headword: string; senses: { definition: string | null; translations: string[]; pos?: string }[] };

const THIN: Group = { headword: "cat", senses: [{ definition: null, translations: [] }] };
const FULL: Group = {
  headword: "cat",
  senses: [{ definition: "a small pet", translations: ["gato", "gata", "felino", "minino", "micho"], pos: "n" }],
};

const state = {
  client: "caller" as string | null,
  clientAllows: true,
  shareAllows: true,
  shareClaims: [] as unknown[][],
  dailyAllows: true,
  clientClaims: [] as unknown[][],
  dailyClaims: [] as unknown[],
  modelCalls: 0,
  providerUrls: [] as string[],
  openaiContent: "el gato" as unknown,
  group: THIN as Group,
  viaInflection: [] as { lemma: string; rule: string }[],
  cachedText: null as unknown,
  cachedNotes: null as unknown,
  textWrites: [] as unknown[][],
  unlistedWrites: [] as unknown[][],
  unlistedModelArgs: [] as unknown[][],
};

const env = {
  OPENAI_API_KEY: "sk-test" as string | undefined,
  WORD_TEXT_DAILY_CALL_CAP: 10,
  WORD_TEXT_DAILY_CLIENT_CAP: 5,
  WORD_UNLISTED_DAILY_CLIENT_CAP: 6,
  PHRASE_NOTES_DAILY_CALL_CAP: 10,
  PHRASE_NOTES_DAILY_CLIENT_CAP: 7,
  TRANSLATE_DAILY_CLIENT_CAP: 8,
};

const providerFetch = async (url: string) => {
  state.providerUrls.push(url);
  if (url.includes("mymemory")) {
    return { json: async () => ({ responseStatus: 200, responseData: { translatedText: "del proveedor" } }) };
  }
  return { json: async () => ({ choices: [{ message: { content: state.openaiContent } }] }) };
};

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
    claimClientCall: async (...args: unknown[]) => {
      state.clientClaims.push(args);
      return state.clientAllows;
    },
    clientKey: () => state.client,
    scopedClientKey: () => state.client,
  },
});
mock.module(here("../lib/word/caller-share.ts"), {
  namedExports: {
    claimCallerShare: async (...args: unknown[]) => {
      state.shareClaims.push(args);
      return state.shareAllows;
    },
  },
});
mock.module(here("../lib/word/spend.ts"), {
  namedExports: {
    claimDailyCall: async (cap: unknown) => {
      state.dailyClaims.push(cap);
      return state.dailyAllows;
    },
  },
});
mock.module(here("../lib/word/dictionary-index.ts"), { namedExports: { loadDictionaryIndex: () => ({}) } });
mock.module(here("../lib/dictionary/index-build.ts"), { namedExports: { groupFor: () => state.group } });
mock.module(here("../lib/dictionary/lookup.ts"), {
  namedExports: { lookupWord: () => ({ exact: null, viaInflection: state.viaInflection, correction: [] }) },
});
mock.module(here("../lib/word/model.ts"), {
  namedExports: {
    MODEL_NAME: "stub",
    generateWordText: async () => {
      state.modelCalls += 1;
      return { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: ["gato"] };
    },
  },
});
mock.module(here("../lib/word/unlisted-model.ts"), {
  namedExports: {
    generateUnlistedAnswer: async (...args: unknown[]) => {
      state.modelCalls += 1;
      state.unlistedModelArgs.push(args);
      return { translations: ["zorblax"], definition: null, example: { en: "A zorblax.", es: "Un zorblax." } };
    },
  },
});
mock.module(here("../lib/phrase/notes-model.ts"), {
  namedExports: {
    NOTES_MODEL_NAME: "stub",
    generateNotes: async () => {
      state.modelCalls += 1;
      return [{ term: "cat", note: "gato" }];
    },
  },
});
mock.module(here("../lib/word/text-cache.ts"), {
  namedExports: {
    readCachedText: async () => state.cachedText,
    writeCachedText: async (...args: unknown[]) => {
      state.textWrites.push(args);
    },
    markTranslationsAsked: async () => {},
    translationsWereAnswered: () => false,
  },
});
mock.module(here("../lib/word/unlisted-cache.ts"), {
  namedExports: {
    readCachedAnswer: async () => null,
    writeCachedAnswer: async (...args: unknown[]) => {
      state.unlistedWrites.push(args);
    },
  },
});
mock.module(here("../lib/phrase/notes-cache.ts"), {
  namedExports: { phraseHash: () => "hash", readCachedNotes: async () => state.cachedNotes, writeCachedNotes: async () => {} },
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
const SENTENCE = { text: "the cat" };

beforeEach(() => {
  state.client = "caller";
  state.clientAllows = true;
  state.shareAllows = true;
  state.shareClaims = [];
  state.dailyAllows = true;
  state.clientClaims = [];
  state.dailyClaims = [];
  state.modelCalls = 0;
  state.providerUrls = [];
  state.openaiContent = "el gato";
  state.group = THIN;
  state.viaInflection = [];
  state.cachedText = null;
  state.cachedNotes = null;
  state.textWrites = [];
  state.unlistedWrites = [];
  state.unlistedModelArgs = [];
  env.OPENAI_API_KEY = "sk-test";
  env.WORD_TEXT_DAILY_CALL_CAP = 10;
  env.PHRASE_NOTES_DAILY_CALL_CAP = 10;
  mock.method(console, "error", () => {});
});

const openaiCalls = () => state.providerUrls.filter((u) => u.includes("openai")).length;

// word/text

test("word/text: inside both caps the model answers and each claim names its own cap", async () => {
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 200);
  assert.equal(state.modelCalls, 1);
  assert.deepEqual(state.clientClaims, [["caller", 5]]);
  assert.deepEqual(state.dailyClaims, [10]);
});

test("word/text: a caller nobody can charge never reaches the model", async () => {
  state.client = null;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assert.equal(state.dailyClaims.length, 0);
});

test("word/text: a caller over their cap never reaches the model nor spends the day", async () => {
  state.clientAllows = false;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assert.equal(state.dailyClaims.length, 0, "a refused caller took one of the day's calls");
});

test("word/text: a day already spent never reaches the model", async () => {
  state.dailyAllows = false;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post(TEXT));
  assert.equal(response.status, 204);
  assert.equal(state.modelCalls, 0);
  assert.deepEqual(state.dailyClaims, [10]);
});

test("word/text: a non-thin word caches and returns no translations", async () => {
  state.group = FULL;
  const { POST } = await import("../app/api/word/text/route");
  const response = await POST(post({ headword: "cat", needDefinition: false }));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { translations: unknown }).translations, null);
  assert.equal(state.textWrites.length, 1);
  assert.equal(state.textWrites[0][5], null, "translations were stored for a word the dictionary is not thin on");
});

test("word/text: a cached answer carries the definition only when the caller asked", async () => {
  state.group = FULL;
  state.cachedText = {
    definition: "a pet",
    example: { en: "A cat.", es: "Un gato." },
    translations: null,
    translationsAsked: false,
  };
  const { POST } = await import("../app/api/word/text/route");
  const without = await POST(post({ headword: "cat", needDefinition: false }));
  assert.equal(((await without.json()) as { definition: unknown }).definition, null);
  const asked = await POST(post({ headword: "cat", needDefinition: true }));
  assert.equal(((await asked.json()) as { definition: unknown }).definition, "a pet");
  assert.equal(state.modelCalls, 0);
});

// word/unlisted

test("word/unlisted: an inflected word stores and returns its lemma and rule", async () => {
  state.viaInflection = [{ lemma: "zorb", rule: "plural-s" }];
  const { POST } = await import("../app/api/word/unlisted/route");
  const response = await POST(post(UNLISTED));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { lemma: unknown; rule: unknown };
  assert.equal(body.lemma, "zorb");
  assert.equal(body.rule, "plural-s");
  assert.equal(state.unlistedWrites.length, 1);
  assert.equal(state.unlistedWrites[0][1], "zorb");
  assert.equal(state.unlistedWrites[0][2], "plural-s");
  assert.deepEqual(state.unlistedModelArgs[0][1], { lemma: "zorb", rule: "plural-s" });
});

test("word/unlisted: a word with no trace stores a null lemma and rule", async () => {
  const { POST } = await import("../app/api/word/unlisted/route");
  await POST(post(UNLISTED));
  assert.equal(state.unlistedWrites[0][1], null);
  assert.equal(state.unlistedWrites[0][2], null);
  assert.equal(state.unlistedModelArgs[0][1], null);
});

// phrase/notes

test("phrase/notes: the day's ceiling is the lower of the route's own and the global one", async () => {
  const { POST } = await import("../app/api/phrase/notes/route");
  env.PHRASE_NOTES_DAILY_CALL_CAP = 3;
  env.WORD_TEXT_DAILY_CALL_CAP = 10;
  assert.equal((await POST(post(NOTES))).status, 200);
  env.PHRASE_NOTES_DAILY_CALL_CAP = 10;
  env.WORD_TEXT_DAILY_CALL_CAP = 4;
  assert.equal((await POST(post(NOTES))).status, 200);
  assert.deepEqual(state.dailyClaims, [3, 4]);
});

test("phrase/notes: a day already spent never reaches the model", async () => {
  state.dailyAllows = false;
  const { POST } = await import("../app/api/phrase/notes/route");
  assert.equal((await POST(post(NOTES))).status, 204);
  assert.equal(state.modelCalls, 0);
});

// translate

test("translate: the model answers first inside the day's cap and claims the global cap", async () => {
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.deepEqual(await response.json(), { text: "el gato", origin: "network" });
  assert.equal(openaiCalls(), 1);
  assert.deepEqual(state.dailyClaims, [10]);
  assert.deepEqual(state.clientClaims, [["caller", 8]]);
});

test("translate: a day already spent never calls the model and MyMemory answers", async () => {
  state.dailyAllows = false;
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.equal(((await response.json()) as { text: string }).text, "del proveedor");
  assert.equal(openaiCalls(), 0);
});

test("translate: with no key the model is not called and the day is not claimed", async () => {
  env.OPENAI_API_KEY = undefined;
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.equal(((await response.json()) as { text: string }).text, "del proveedor");
  assert.equal(openaiCalls(), 0);
  assert.equal(state.dailyClaims.length, 0);
});

test("translate: with no daily cap configured the model is not called", async () => {
  env.WORD_TEXT_DAILY_CALL_CAP = 0;
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.equal(((await response.json()) as { text: string }).text, "del proveedor");
  assert.equal(openaiCalls(), 0);
  assert.equal(state.dailyClaims.length, 0);
});

test("translate: a caller over their allowance is refused with 429 before any provider", async () => {
  state.clientAllows = false;
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rateLimited" });
  assert.equal(state.providerUrls.length, 0);
  assert.equal(state.dailyClaims.length, 0);
});

test("translate: a model reply that echoes the sentence is no translation", async () => {
  state.openaiContent = "  The Cat ";
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post(SENTENCE));
  assert.equal(((await response.json()) as { text: string }).text, "del proveedor");
});

// the caller's share of the day

test("a caller past their share never reaches the model nor spends the day, on every paid route", async () => {
  state.shareAllows = false;
  const text = await import("../app/api/word/text/route");
  const unlisted = await import("../app/api/word/unlisted/route");
  const notes = await import("../app/api/phrase/notes/route");
  const translate = await import("../app/api/translate/route");
  assert.equal((await text.POST(post(TEXT))).status, 204);
  assert.equal((await unlisted.POST(post(UNLISTED))).status, 204);
  assert.equal((await notes.POST(post(NOTES))).status, 204);
  assert.equal(state.modelCalls, 0);
  assert.equal(state.dailyClaims.length, 0);
  assert.equal(state.clientClaims.length, 0);
  assert.deepEqual(state.shareClaims.map((c) => c[1]), [10, 10, 10]);
  // translate falls to the provider, never the model
  assert.equal((await translate.POST(post(SENTENCE))).status, 200);
  assert.equal(openaiCalls(), 0);
});

test("the share is claimed before the route's own caller claim", async () => {
  const { POST } = await import("../app/api/word/unlisted/route");
  await POST(post(UNLISTED));
  assert.equal(state.shareClaims.length, 1);
  assert.deepEqual(state.shareClaims[0], ["caller", 10]);
});
