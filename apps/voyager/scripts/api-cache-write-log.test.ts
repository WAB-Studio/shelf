// A cache write that keeps failing while the claims succeed re-spends a model
// call on every lookup of that word and is visible only as a log line. The line
// must name the route and the word key so an alert can group on them.
//
// `todo`: the routes log the route and the error, not the key (measured
// 2026-10-15). Remove `todo` when the line carries it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;
const failure = new Error("constraint refused");
const fail = async (): Promise<never> => {
  throw failure;
};

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

mock.module(here("../lib/env.ts"), {
  namedExports: {
    env: {
      OPENAI_API_KEY: "sk-test",
      WORD_TEXT_DAILY_CALL_CAP: 10,
      WORD_TEXT_DAILY_CLIENT_CAP: 5,
      WORD_UNLISTED_DAILY_CLIENT_CAP: 5,
      PHRASE_NOTES_DAILY_CALL_CAP: 10,
      PHRASE_NOTES_DAILY_CLIENT_CAP: 5,
    },
  },
});
mock.module(here("../lib/word/client-budget.ts"), {
  namedExports: { claimClientCall: async () => true, clientKey: () => "c", scopedClientKey: () => "c" },
});
mock.module(here("../lib/word/spend.ts"), { namedExports: { claimDailyCall: async () => true } });
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
    generateWordText: async () => ({ definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: ["gato"] }),
  },
});
mock.module(here("../lib/word/unlisted-model.ts"), {
  namedExports: {
    generateUnlistedAnswer: async () => ({ translations: ["zorblax"], definition: null, example: { en: "A z.", es: "Un z." } }),
  },
});
mock.module(here("../lib/phrase/notes-model.ts"), {
  namedExports: { NOTES_MODEL_NAME: "stub", generateNotes: async () => [{ term: "cat", note: "gato" }] },
});
mock.module(here("../lib/word/text-cache.ts"), {
  namedExports: {
    readCachedText: async () => null,
    writeCachedText: fail,
    markTranslationsAsked: fail,
    translationsWereAnswered: () => false,
  },
});
mock.module(here("../lib/word/unlisted-cache.ts"), {
  namedExports: { readCachedAnswer: async () => null, writeCachedAnswer: fail },
});
mock.module(here("../lib/phrase/notes-cache.ts"), {
  namedExports: { phraseHash: () => "phrase-hash-77", readCachedNotes: async () => null, writeCachedNotes: fail },
});

function post(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

const CASES = [
  { route: "api/word/text", key: "cat", load: () => import("../app/api/word/text/route"), body: { headword: "cat", needDefinition: true } },
  { route: "api/word/unlisted", key: "zorblax", load: () => import("../app/api/word/unlisted/route"), body: { word: "zorblax" } },
  { route: "api/phrase/notes", key: "phrase-hash-77", load: () => import("../app/api/phrase/notes/route"), body: { source: "the cat sat down", translation: "el gato se sento" } },
];

for (const c of CASES) {
  test(`${c.route}: a failing cache write logs one line naming the route and the key`, { todo: "log line does not carry the key" }, async () => {
    const { POST } = await c.load();
    const response = await POST(post(c.body));
    assert.equal(response.status, 200);
    assert.equal(logged.length, 1, `one log line, got ${logged.length}`);
    assert.ok(logged[0].includes(c.route), logged[0]);
    assert.ok(logged[0].includes("cache write failed"), logged[0]);
    assert.ok(logged[0].includes(c.key), `no key in: ${logged[0]}`);
  });
}
