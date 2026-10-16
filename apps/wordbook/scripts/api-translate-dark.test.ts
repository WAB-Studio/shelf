// W2: /api/translate never spends the model for a caller it cannot charge, and
// every fall to MyMemory writes exactly one `[paid-dark] translate <reason>`
// line carrying nothing of the reader's. Claims and providers are stand-ins
// that count calls: nothing is read, written or spent.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

const SENTENCE = "the quiet harbour sleeps";
const CALLER = "ck-7e1d";
const MODEL_TEXT = "el puerto tranquilo duerme";
const MYMEMORY_TEXT = "el puerto callado duerme";
const EXPLICIT = "Quiero que me la chupes hasta que me corra en tu boca.";

const state = {
  client: CALLER as string | null,
  scopedClient: "scoped-1" as string | null,
  shareAllows: true,
  clientAllows: true,
  dailyAllows: true,
  shareThrows: false,
  dailyThrows: false,
  clientThrows: false,
  shareClaims: 0,
  clientClaims: 0,
  dailyClaims: 0,
  openaiCalls: 0,
  mymemoryCalls: 0,
  // What the model's provider answers: a reply body, null (provider failed) or a broken body.
  openai: "reply" as "reply" | "null" | "empty" | "echo" | "badjson" | "blocked",
};

const env: Record<string, unknown> = {
  OPENAI_API_KEY: "sk-test",
  WORD_TEXT_DAILY_CALL_CAP: 10,
  TRANSLATE_DAILY_CLIENT_CAP: 8,
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
    scopedClientKey: () => state.scopedClient,
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
mock.module(here("../lib/word/model.ts"), { namedExports: { MODEL_NAME: "stub" } });
mock.module(here("../lib/provider/fetch.ts"), {
  namedExports: {
    providerFetch: async (_url: string, _init: unknown, opts: { name: string }) => {
      if (opts.name === "openai-translate") {
        state.openaiCalls += 1;
        if (state.openai === "null") return null;
        if (state.openai === "badjson") return { json: async () => { throw new SyntaxError("bad"); } };
        const content =
          state.openai === "empty" ? "  " : state.openai === "echo" ? ` ${SENTENCE.toUpperCase()} ` : state.openai === "blocked" ? EXPLICIT : MODEL_TEXT;
        return { json: async () => ({ choices: [{ message: { content } }] }) };
      }
      state.mymemoryCalls += 1;
      return { json: async () => ({ responseStatus: 200, responseData: { translatedText: MYMEMORY_TEXT }, matches: [] }) };
    },
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
    scopedClient: "scoped-1",
    shareAllows: true,
    clientAllows: true,
    dailyAllows: true,
    shareThrows: false,
    dailyThrows: false,
    clientThrows: false,
    shareClaims: 0,
    clientClaims: 0,
    dailyClaims: 0,
    openaiCalls: 0,
    mymemoryCalls: 0,
    openai: "reply",
  });
  Object.assign(env, { OPENAI_API_KEY: "sk-test", WORD_TEXT_DAILY_CALL_CAP: 10, TRANSLATE_DAILY_CLIENT_CAP: 8 });
});
afterEach(() => Object.assign(console, real));

function post(body: unknown = { text: SENTENCE }, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function run(request: Request = post()): Promise<Response> {
  return (await import("../app/api/translate/route")).POST(request);
}

const darkLines = () => warns.filter((w) => w[0] === "[paid-dark]");

function assertOneLine(reason: string) {
  assert.deepEqual(darkLines(), [["[paid-dark]", "translate", reason]]);
}

function assertMyMemoryAnswered(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(state.mymemoryCalls, 1);
}

// The reader's sentence, the caller key and the key's value ride in no warn argument.
function assertNothingOfTheReader() {
  const flat = JSON.stringify(warns.flat().map((a) => (a instanceof Error ? a.message : a)));
  for (const secret of [SENTENCE, SENTENCE.toUpperCase(), CALLER, "scoped-1", "sk-test", MODEL_TEXT, MYMEMORY_TEXT]) {
    assert.ok(!flat.includes(secret), `a warn argument carried ${secret}`);
  }
}

test("translate: a caller with no key reaches MyMemory with no claim and no model call", async () => {
  state.client = null;
  state.scopedClient = null;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.deepEqual(await response.json(), { text: MYMEMORY_TEXT, origin: "network" });
  assert.equal(state.openaiCalls, 0);
  assert.equal(state.shareClaims, 0);
  assert.equal(state.dailyClaims, 0);
  assertOneLine("no-caller");
  assertNothingOfTheReader();
});

test("translate: no key for the model while the route's own caller key exists still refuses the model", async () => {
  state.client = null;
  state.scopedClient = "scoped-1";
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.openaiCalls, 0);
  assert.equal(state.dailyClaims, 0);
  assertOneLine("no-caller");
});

test("translate: no OPENAI_API_KEY logs no-key and MyMemory answers", async () => {
  env.OPENAI_API_KEY = undefined;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("no-key");
  assertNothingOfTheReader();
});

test("translate: no day cap configured logs no-cap and MyMemory answers", async () => {
  env.WORD_TEXT_DAILY_CALL_CAP = undefined;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("no-cap");
});

test("translate: a refused caller share logs caller-share, claims no day call and never reaches the model", async () => {
  state.shareAllows = false;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.dailyClaims, 0);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("caller-share");
  assertNothingOfTheReader();
});

test("translate: a spent day cap logs day-cap and never reaches the model", async () => {
  state.dailyAllows = false;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.shareClaims, 1);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("day-cap");
});

test("translate: a share claim that throws logs claim-error, keeps the error line and MyMemory answers", async () => {
  state.shareThrows = true;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("claim-error");
  assert.ok(errors.some((e) => e.includes(boom)));
});

test("translate: a day claim that throws logs claim-error and MyMemory answers", async () => {
  state.dailyThrows = true;
  const response = await run();
  assertMyMemoryAnswered(response);
  assert.equal(state.openaiCalls, 0);
  assertOneLine("claim-error");
  assertNothingOfTheReader();
});

for (const mode of ["null", "empty", "echo", "badjson"] as const) {
  test(`translate: a model reply of kind ${mode} logs model-failed and MyMemory answers`, async () => {
    state.openai = mode;
    const response = await run();
    assertMyMemoryAnswered(response);
    assert.equal(state.openaiCalls, 1);
    assert.deepEqual(await response.json(), { text: MYMEMORY_TEXT, origin: "network" });
    assertOneLine("model-failed");
    assertNothingOfTheReader();
  });
}

test("translate: the model answers, MyMemory is not asked and no line is logged", async () => {
  const response = await run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: MODEL_TEXT, origin: "network" });
  assert.equal(state.openaiCalls, 1);
  assert.equal(state.mymemoryCalls, 0);
  assert.equal(state.shareClaims, 1);
  assert.equal(state.dailyClaims, 1);
  assert.deepEqual(darkLines(), []);
});

test("translate: the model's reply is not passed through the blocklist (RL-64)", async () => {
  state.openai = "blocked";
  const response = await run();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: EXPLICIT, origin: "network" });
  assert.deepEqual(darkLines(), []);
});

test("translate: a caller over its own cap is answered 429 before any claim, model or provider, with no dark line", async () => {
  state.clientAllows = false;
  const response = await run();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rateLimited" });
  assert.equal(state.shareClaims, 0);
  assert.equal(state.dailyClaims, 0);
  assert.equal(state.openaiCalls, 0);
  assert.equal(state.mymemoryCalls, 0);
  assert.deepEqual(darkLines(), []);
});

test("translate: a caller with no key stays open (RL-09): no caller claim is made", async () => {
  state.client = null;
  state.scopedClient = null;
  const response = await run();
  assert.equal(response.status, 200);
  assert.equal(state.clientClaims, 0);
});

test("translate: a bad body (400) and a cross-site request (403) log nothing", async () => {
  const invalid = await run(post("{not json"));
  assert.equal(invalid.status, 400);
  const empty = await run(post({ text: "" }));
  assert.equal(empty.status, 400);
  const foreign = await run(post({ text: SENTENCE }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
  assert.equal(foreign.status, 403);
  assert.deepEqual(darkLines(), []);
  assert.equal(state.openaiCalls, 0);
});
