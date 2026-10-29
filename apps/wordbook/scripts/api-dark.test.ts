// W1: every 204 a paid word route answers for a dark reason writes exactly one
// `[paid-dark] <route> <reason>` line, nothing of the reader's rides in it, and
// every status, body and header stays what it was. Every claim, cache, model
// and session is a stand-in that counts calls: nothing is read, written or spent.
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
const SWISH: Group = {
  headword: "swish",
  senses: [{ definition: "a swish", translations: ["a", "b", "c", "d", "e", "f"], pos: "adj" }],
};

const CALLER = "ck-7e1d";
const state = {
  client: CALLER as string | null,
  shareAllows: true,
  clientAllows: true,
  dailyAllows: true,
  shareThrows: false,
  clientThrows: false,
  dailyThrows: false,
  readThrows: false,
  writeThrows: false,
  modelNull: false,
  modelCalls: 0,
  shareClaims: 0,
  clientClaims: 0,
  dailyClaims: 0,
  textModelArgs: [] as unknown[][],
  groups: {} as Record<string, Group>,
  cachedText: null as unknown,
  cachedAnswer: null as unknown,
  cachedNotes: null as unknown,
  exact: null as unknown,
  reader: { id: "reader-1", email: "r@example.invalid" } as { id: string; email: string } | null,
};

const env = {
  OPENAI_API_KEY: "sk-test" as string | undefined,
  WORD_TEXT_DAILY_CALL_CAP: 10,
  WORD_TEXT_DAILY_CLIENT_CAP: 5,
  WORD_UNLISTED_DAILY_CLIENT_CAP: 6,
  PHRASE_NOTES_DAILY_CALL_CAP: 10,
  PHRASE_NOTES_DAILY_CLIENT_CAP: 7,
};

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

const boom = new Error("stub failure");

mock.module(here("../lib/env.ts"), { namedExports: { env } });
mock.module(here("../lib/word/client-budget.ts"), {
  namedExports: {
    claimClientCall: async () => {
      state.clientClaims += 1;
      if (state.clientThrows) throw boom;
      return state.clientAllows;
    },
    clientKey: () => state.client,
    scopedClientKey: () => state.client,
  },
});
mock.module(here("../lib/word/caller-share.ts"), {
  namedExports: {
    claimCallerShare: async () => {
      state.shareClaims += 1;
      if (state.shareThrows) throw boom;
      return state.shareAllows;
    },
  },
});
mock.module(here("../lib/word/spend.ts"), {
  namedExports: {
    claimDailyCall: async () => {
      state.dailyClaims += 1;
      if (state.dailyThrows) throw boom;
      return state.dailyAllows;
    },
  },
});
mock.module(here("../lib/word/dictionary-index.ts"), { namedExports: { loadDictionaryIndex: () => ({}) } });
mock.module(here("../lib/dictionary/index-build.ts"), {
  namedExports: { groupFor: (_index: unknown, word: string) => state.groups[word] ?? null },
});
mock.module(here("../lib/dictionary/lookup.ts"), {
  namedExports: { lookupWord: () => ({ exact: state.exact, viaInflection: [], correction: [] }) },
});
mock.module(here("../lib/word/model.ts"), {
  namedExports: {
    MODEL_NAME: "stub",
    generateWordText: async (...args: unknown[]) => {
      state.modelCalls += 1;
      state.textModelArgs.push(args);
      if (state.modelNull) return null;
      return { definition: "a pet", example: { en: "A cat.", es: "Un gato." }, translations: ["gato"] };
    },
  },
});
mock.module(here("../lib/word/unlisted-model.ts"), {
  namedExports: {
    generateUnlistedAnswer: async () => {
      state.modelCalls += 1;
      if (state.modelNull) return null;
      return { translations: ["zorblax"], definition: null, example: { en: "A zorblax.", es: "Un zorblax." } };
    },
  },
});
mock.module(here("../lib/phrase/notes-model.ts"), {
  namedExports: {
    NOTES_MODEL_NAME: "stub",
    generateNotes: async () => {
      state.modelCalls += 1;
      if (state.modelNull) return null;
      return [{ term: "cat", note: "gato" }];
    },
  },
});
mock.module(here("../lib/word/text-cache.ts"), {
  namedExports: {
    readCachedText: async () => {
      if (state.readThrows) throw boom;
      return state.cachedText;
    },
    writeCachedText: async () => {
      if (state.writeThrows) throw boom;
    },
    markTranslationsAsked: async () => {},
    translationsWereAnswered: () => false,
  },
});
mock.module(here("../lib/word/unlisted-cache.ts"), {
  namedExports: {
    readCachedAnswer: async () => {
      if (state.readThrows) throw boom;
      return state.cachedAnswer;
    },
    writeCachedAnswer: async () => {
      if (state.writeThrows) throw boom;
    },
  },
});
mock.module(here("../lib/phrase/notes-cache.ts"), {
  namedExports: {
    phraseHash: () => "hash-3b9c",
    readCachedNotes: async () => {
      if (state.readThrows) throw boom;
      return state.cachedNotes;
    },
    writeCachedNotes: async () => {
      if (state.writeThrows) throw boom;
    },
  },
});
mock.module(here("../lib/session.ts"), {
  namedExports: {
    getReader: async () => state.reader,
    withReaderDb: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => [] }),
  },
});
mock.module(here("../lib/sync/upload.ts"), {
  namedExports: {
    writeUpload: async () => ({ status: "ok", accepted: 0, buried: 0, tombstones: [] }),
    downloadRows: async () => [],
  },
});

const real = { warn: console.warn, error: console.error };
let warns: unknown[][] = [];
let errors: unknown[][] = [];

beforeEach(() => {
  warns = [];
  errors = [];
  console.warn = (...a: unknown[]) => void warns.push(a);
  console.error = (...a: unknown[]) => void errors.push(a);
  Object.assign(state, {
    client: CALLER,
    shareAllows: true,
    clientAllows: true,
    dailyAllows: true,
    shareThrows: false,
    clientThrows: false,
    dailyThrows: false,
    readThrows: false,
    writeThrows: false,
    modelNull: false,
    modelCalls: 0,
    shareClaims: 0,
    clientClaims: 0,
    dailyClaims: 0,
    textModelArgs: [],
    groups: { cat: THIN },
    cachedText: null,
    cachedAnswer: null,
    cachedNotes: null,
    exact: null,
    reader: { id: "reader-1", email: "r@example.invalid" },
  });
  Object.assign(env, {
    OPENAI_API_KEY: "sk-test",
    WORD_TEXT_DAILY_CALL_CAP: 10,
    WORD_UNLISTED_DAILY_CLIENT_CAP: 6,
    PHRASE_NOTES_DAILY_CALL_CAP: 10,
    PHRASE_NOTES_DAILY_CLIENT_CAP: 7,
  });
});
afterEach(() => Object.assign(console, real));

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Route = {
  name: "word/text" | "word/unlisted" | "phrase/notes";
  body: unknown;
  call: (request: Request) => Promise<Response>;
  // The env switches that, unset, are the route's «no cap» reason.
  capKeys: (keyof typeof env)[];
};

const ROUTES: Route[] = [
  {
    name: "word/text",
    body: { headword: "cat", needDefinition: true },
    call: async (r) => (await import("../app/api/word/text/route")).POST(r),
    capKeys: ["WORD_TEXT_DAILY_CALL_CAP"],
  },
  {
    name: "word/unlisted",
    body: { word: "zorblax" },
    call: async (r) => (await import("../app/api/word/unlisted/route")).POST(r),
    capKeys: ["WORD_UNLISTED_DAILY_CLIENT_CAP", "WORD_TEXT_DAILY_CALL_CAP"],
  },
  {
    name: "phrase/notes",
    body: { source: "the cat sat down", translation: "el gato se sento" },
    call: async (r) => (await import("../app/api/phrase/notes/route")).POST(r),
    capKeys: ["PHRASE_NOTES_DAILY_CALL_CAP", "PHRASE_NOTES_DAILY_CLIENT_CAP", "WORD_TEXT_DAILY_CALL_CAP"],
  },
];

// Nothing of the reader's rides in a line: not the word, the phrase, the hash,
// the caller key, the key or the cap.
const READER_INPUT = ["cat", "zorblax", "sat down", "gato", CALLER, "hash-3b9c", "sk-test", "swish"];

function assertDarkLine(route: string, reason: string): void {
  assert.deepEqual(warns, [["[paid-dark]", route, reason]]);
  const text = JSON.stringify(warns);
  for (const secret of READER_INPUT) assert.ok(!text.includes(secret), `the dark line carries ${secret}`);
}

async function assertDark204(response: Response): Promise<void> {
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
}

for (const route of ROUTES) {
  const miss = async (): Promise<Response> => route.call(post(route.body));

  test(`${route.name}: no OPENAI_API_KEY answers 204 and logs no-key, spending nothing`, async () => {
    env.OPENAI_API_KEY = undefined;
    await assertDark204(await miss());
    assertDarkLine(route.name, "no-key");
    assert.equal(state.modelCalls + state.shareClaims + state.clientClaims + state.dailyClaims, 0);
  });

  for (const capKey of route.capKeys) {
    test(`${route.name}: ${capKey} unset answers 204 and logs no-cap`, async () => {
      (env as Record<string, unknown>)[capKey] = 0;
      await assertDark204(await miss());
      assertDarkLine(route.name, "no-cap");
      assert.equal(state.modelCalls, 0);
    });
  }

  test(`${route.name}: no chargeable caller answers 204 and logs no-caller, claiming nothing`, async () => {
    state.client = null;
    await assertDark204(await miss());
    assertDarkLine(route.name, "no-caller");
    assert.equal(state.modelCalls + state.dailyClaims + state.clientClaims, 0);
  });

  test(`${route.name}: the share refused logs caller-share and claims neither the caller nor the day`, async () => {
    state.shareAllows = false;
    await assertDark204(await miss());
    assertDarkLine(route.name, "caller-share");
    assert.equal(state.shareClaims, 1);
    assert.equal(state.clientClaims, 0);
    assert.equal(state.dailyClaims, 0);
    assert.equal(state.modelCalls, 0);
  });

  test(`${route.name}: the caller's cap refused logs caller-cap and never claims the day`, async () => {
    state.clientAllows = false;
    await assertDark204(await miss());
    assertDarkLine(route.name, "caller-cap");
    assert.equal(state.shareClaims, 1);
    assert.equal(state.clientClaims, 1);
    assert.equal(state.dailyClaims, 0);
    assert.equal(state.modelCalls, 0);
  });

  test(`${route.name}: the day's cap refused logs day-cap`, async () => {
    state.dailyAllows = false;
    await assertDark204(await miss());
    assertDarkLine(route.name, "day-cap");
    assert.equal(state.dailyClaims, 1);
    assert.equal(state.modelCalls, 0);
  });

  for (const which of ["shareThrows", "clientThrows", "dailyThrows"] as const) {
    test(`${route.name}: a claim that throws (${which}) answers 204, logs claim-error and still console.errors the error`, async () => {
      state[which] = true;
      await assertDark204(await miss());
      assertDarkLine(route.name, "claim-error");
      assert.ok(errors.some((call) => call.includes(boom)), "console.error lost the thrown error");
      assert.equal(state.modelCalls, 0);
    });
  }

  test(`${route.name}: a cache read that throws answers 204, logs cache-error and still console.errors the error`, async () => {
    state.readThrows = true;
    await assertDark204(await miss());
    assertDarkLine(route.name, "cache-error");
    assert.ok(errors.some((call) => call.includes(boom)), "console.error lost the thrown error");
    assert.equal(state.modelCalls, 0);
  });

  test(`${route.name}: a generation that fails answers 204 and logs model-failed`, async () => {
    state.modelNull = true;
    await assertDark204(await miss());
    assertDarkLine(route.name, "model-failed");
    assert.equal(state.modelCalls, 1);
  });

  test(`${route.name}: a cache write that fails still answers 200 and logs nothing dark`, async () => {
    state.writeThrows = true;
    const response = await miss();
    assert.equal(response.status, 200);
    assert.deepEqual(warns, []);
    assert.ok(errors.some((call) => call.includes(boom)), "the existing cache write line is gone");
  });

  test(`${route.name}: inside every cap the model answers 200 and the log stays silent`, async () => {
    const response = await miss();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(state.modelCalls, 1);
    assert.deepEqual(warns, []);
  });

  test(`${route.name}: a cache hit answers 200 with the log silent, even with no key`, async () => {
    state.cachedText = {
      definition: "a pet",
      example: { en: "A cat.", es: "Un gato." },
      translations: null,
      translationsAsked: true,
    };
    state.cachedAnswer = {
      translations: ["zorblax"],
      definition: null,
      example: { en: "A zorblax.", es: "Un zorblax." },
      lemma: null,
      rule: null,
    };
    state.cachedNotes = [{ term: "cat", note: "gato" }];
    env.OPENAI_API_KEY = undefined;
    const response = await miss();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(warns, []);
    assert.equal(state.modelCalls, 0);
  });

  test(`${route.name}: a bad body (400), a foreign origin (403) and a non-JSON type (415) log nothing, even dark`, async () => {
    env.OPENAI_API_KEY = undefined;
    const invalidJson = await route.call(post("{not json"));
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.headers.get("cache-control"), "no-store");
    const invalidShape = await route.call(post({ nothing: true }));
    assert.equal(invalidShape.status, 400);
    assert.equal(invalidShape.headers.get("cache-control"), "no-store");
    const foreign = await route.call(post(route.body, { origin: "http://evil.example" }));
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("cache-control"), "no-store");
    const wrongType = await route.call(post(route.body, { "content-type": "text/plain" }));
    assert.equal(wrongType.status, 415);
    assert.deepEqual(warns, []);
  });
}

test("the 400 bodies stay what they were: text and notes answer {error:invalid}, unlisted answers nothing", async () => {
  const text = await ROUTES[0].call(post("{not json"));
  assert.deepEqual(await text.json(), { error: "invalid" });
  const notes = await ROUTES[2].call(post("{not json"));
  assert.deepEqual(await notes.json(), { error: "invalid" });
  const unlisted = await ROUTES[1].call(post("{not json"));
  assert.equal(await unlisted.text(), "");
});

test("word/text: a headword outside the dictionary is a 400 that logs nothing", async () => {
  env.OPENAI_API_KEY = undefined;
  state.groups = {};
  const response = await ROUTES[0].call(post(ROUTES[0].body));
  assert.equal(response.status, 400);
  assert.deepEqual(warns, []);
});

test("word/unlisted: a word the dictionary lists is a 400 that logs nothing", async () => {
  env.OPENAI_API_KEY = undefined;
  state.exact = { headword: "zorblax" };
  const response = await ROUTES[1].call(post(ROUTES[1].body));
  assert.equal(response.status, 400);
  assert.deepEqual(warns, []);
});

// word/text: the enrichment of a cached thin row

const CACHED_THIN = {
  definition: "a pet",
  example: { en: "A cat.", es: "Un gato." },
  translations: null,
  translationsAsked: false,
};

const REFUSALS: [string, () => void][] = [
  ["no-key", () => void (env.OPENAI_API_KEY = undefined)],
  ["no-cap", () => void (env.WORD_TEXT_DAILY_CALL_CAP = 0)],
  ["no-caller", () => void (state.client = null)],
  ["caller-share", () => void (state.shareAllows = false)],
  ["caller-cap", () => void (state.clientAllows = false)],
  ["day-cap", () => void (state.dailyAllows = false)],
  ["claim-error", () => void (state.dailyThrows = true)],
];

for (const [reason, refuse] of REFUSALS) {
  test(`word/text: a cached thin row whose enrichment is refused (${reason}) still answers 200 with the cached text and logs it`, async () => {
    state.cachedText = CACHED_THIN;
    refuse();
    const response = await ROUTES[0].call(post(ROUTES[0].body));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as { definition: unknown; example: unknown; translations: unknown };
    assert.equal(body.definition, "a pet");
    assert.deepEqual(body.example, { en: "A cat.", es: "Un gato." });
    assert.equal(body.translations, null);
    assert.equal(state.modelCalls, 0);
    assertDarkLine("word/text", reason);
  });
}

test("word/text: a cached thin row enriched inside the caps logs nothing", async () => {
  state.cachedText = CACHED_THIN;
  const response = await ROUTES[0].call(post(ROUTES[0].body));
  assert.equal(response.status, 200);
  assert.equal(state.modelCalls, 1);
  assert.deepEqual(warns, []);
});

test("word/text: a cached row that needs no enrichment logs nothing even with no key", async () => {
  env.OPENAI_API_KEY = undefined;
  state.cachedText = { ...CACHED_THIN, translationsAsked: true };
  assert.equal((await ROUTES[0].call(post(ROUTES[0].body))).status, 200);
  state.groups = { cat: SWISH };
  state.cachedText = CACHED_THIN;
  assert.equal((await ROUTES[0].call(post(ROUTES[0].body))).status, 200);
  assert.deepEqual(warns, []);
});

// RL-45's dead claim path

test("word/text: a body with surface and rule is answered as one without, for a word that is not thin", async () => {
  state.groups = { swish: SWISH };
  const plain = await ROUTES[0].call(post({ headword: "swish", needDefinition: false }));
  const claimed = await ROUTES[0].call(
    post({ headword: "swish", needDefinition: false, surface: "swishing", rule: "ing" }),
  );
  assert.equal(plain.status, 200);
  assert.equal(claimed.status, 200);
  assert.equal(state.textModelArgs.length, 2);
  assert.equal(state.textModelArgs[0][2], null, "a plain lookup of a full word was sent as thin");
  assert.equal(state.textModelArgs[1][2], null, "a surface/rule claim made a full word thin");
  assert.equal(((await claimed.json()) as { translations: unknown }).translations, null);
});

test("word/text: an unknown rule in the old claim no longer fails the body", async () => {
  state.groups = { swish: SWISH };
  const response = await ROUTES[0].call(
    post({ headword: "swish", needDefinition: false, surface: "swishing", rule: "no-such-rule" }),
  );
  assert.equal(response.status, 200);
});

test("word/text: a thin word is still sent to the model with its senses, claim or no claim", async () => {
  const response = await ROUTES[0].call(
    post({ headword: "cat", needDefinition: true, surface: "cats", rule: "plural-s" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.textModelArgs[0][2], THIN.senses);
  assert.deepEqual(((await response.json()) as { translations: unknown }).translations, ["gato"]);
});

// log/sync and log/clear

test("log/sync and log/clear answer no-store on 401, 400, 409 and 200", async () => {
  const sync = await import("../app/api/log/sync/route");
  const clear = await import("../app/api/log/clear/route");
  const device = "7f3c2b1e-5a44-4c1d-9a0e-3d2f6b8c9e10";
  const valid = (readerId: string) => post({ deviceId: device, readerId, rows: [], since: null });

  state.reader = null;
  const noSession = [await sync.POST(valid("reader-1")), await clear.DELETE()];
  for (const response of noSession) assert.equal(response.status, 401);

  state.reader = { id: "reader-1", email: "r@example.invalid" };
  const invalid = await sync.POST(post("{not json"));
  assert.equal(invalid.status, 400);
  const other = await sync.POST(valid("someone-else"));
  assert.equal(other.status, 409);
  const ok = await sync.POST(valid("reader-1"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { accepted: 0, rows: [], cursor: null, tombstones: [], tombstoneCursor: null });
  const cleared = await clear.DELETE();
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), {});

  for (const response of [...noSession, invalid, other, ok, cleared]) {
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(warns, []);
});
