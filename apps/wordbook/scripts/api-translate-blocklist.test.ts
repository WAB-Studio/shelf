// RL-64: the provider path refuses a blocked answer. The model is off and
// MyMemory is a stand-in: nothing leaves the machine.
//
// Requires --experimental-test-module-mocks (see package.json's check:unit).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const here = (p: string) => new URL(p, import.meta.url).href;

const EXPLICIT = "Quiero que me la chupes hasta que me corra en tu boca.";

const state = {
  top: EXPLICIT as string,
  matches: [] as { translation: string; match: number }[],
};

const stubRoot = mkdtempSync(path.join(tmpdir(), "server-only-"));
mkdirSync(path.join(stubRoot, "server-only"));
writeFileSync(path.join(stubRoot, "server-only", "index.js"), "module.exports = {};\n");
process.env.NODE_PATH = stubRoot;
(Module as unknown as { _initPaths: () => void })._initPaths();
after(() => rmSync(stubRoot, { recursive: true, force: true }));

mock.module(here("../lib/env.ts"), { namedExports: { env: { TRANSLATE_DAILY_CLIENT_CAP: 8 } } });
mock.module(here("../lib/provider/fetch.ts"), {
  namedExports: {
    providerFetch: async () => ({
      json: async () => ({
        responseStatus: 200,
        responseData: { translatedText: state.top },
        matches: state.matches,
      }),
    }),
  },
});
mock.module(here("../lib/word/client-budget.ts"), {
  namedExports: { claimClientCall: async () => true, clientKey: () => null, scopedClientKey: () => null },
});
mock.module(here("../lib/word/caller-share.ts"), { namedExports: { claimCallerShare: async () => true } });
mock.module(here("../lib/word/spend.ts"), { namedExports: { claimDailyCall: async () => true } });
mock.module(here("../lib/word/model.ts"), { namedExports: { MODEL_NAME: "stub" } });

function post(): Request {
  return new Request("http://localhost/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "i love you" }),
  });
}

beforeEach(() => {
  state.top = EXPLICIT;
  state.matches = [];
  mock.method(console, "error", () => {});
});

test("translate: the explicit sentence at match 1 never reaches the reader", async () => {
  state.matches = [{ translation: EXPLICIT, match: 1 }];
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider" });
});

test("translate: a blocked top pick falls to a clean alternative", async () => {
  state.matches = [
    { translation: EXPLICIT, match: 1 },
    { translation: "te quiero", match: 1 },
  ];
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "te quiero", origin: "network" });
});

test("translate: a clean answer passes untouched", async () => {
  state.top = "te quiero";
  const { POST } = await import("../app/api/translate/route");
  const response = await POST(post());
  assert.deepEqual(await response.json(), { text: "te quiero", origin: "network" });
});
