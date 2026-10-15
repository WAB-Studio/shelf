// Drives the four paid routes' handlers with a built Request. The database,
// the providers and the caps are swapped at module resolution; every double
// records into `calls`, so "no spend" is an assertion on that list.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const calls: string[] = [];
const rec = (name: string, value: unknown) => async () => {
  calls.push(name);
  return value;
};
const double = {
  claimClientCall: rec("claimClientCall", true),
  claimDailyCall: rec("claimDailyCall", true),
  providerFetch: rec("providerFetch", new Response("{}", { status: 500 })),
  generate: rec("model", null),
  read: rec("cache", null),
  write: rec("cache", undefined),
};
(globalThis as unknown as { __originDouble: typeof double }).__originDouble = double;
const D = "globalThis.__originDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/lib/env": `export const env = { TRANSLATE_DAILY_CLIENT_CAP: 300, WORD_TEXT_DAILY_CLIENT_CAP: 150, CLIENT_KEY_SALT: "salt-salt-salt-salt-1" };`,
  "@/lib/word/client-budget": `export const claimClientCall = (...a) => ${D}.claimClientCall(...a);
    export const clientKey = () => "k"; export const scopedClientKey = () => "k";`,
  "@/lib/word/spend": `export const claimDailyCall = (...a) => ${D}.claimDailyCall(...a);`,
  "@/lib/provider/fetch": `export const providerFetch = (...a) => ${D}.providerFetch(...a);`,
  "@/lib/word/model": `export const MODEL_NAME = "m"; export const generateWordText = (...a) => ${D}.generate(...a);`,
  "@/lib/word/unlisted-model": `export const generateUnlistedAnswer = (...a) => ${D}.generate(...a);`,
  "@/lib/phrase/notes-model": `export const NOTES_MODEL_NAME = "m"; export const generateNotes = (...a) => ${D}.generate(...a);`,
  "@/lib/word/dictionary-index": `export const loadDictionaryIndex = () => ({ entries: [], byHeadword: new Map(), sortedHeadwords: [] });`,
  "@/lib/word/text-cache": `export const readCachedText = (...a) => ${D}.read(...a); export const writeCachedText = (...a) => ${D}.write(...a);
    export const readCachedWordText = (...a) => ${D}.read(...a); export const writeCachedWordText = (...a) => ${D}.write(...a);`,
  "@/lib/word/unlisted-cache": `export const readCachedAnswer = (...a) => ${D}.read(...a); export const writeCachedAnswer = (...a) => ${D}.write(...a);`,
  "@/lib/phrase/notes-cache": `export const phraseHash = () => "h"; export const readCachedNotes = (...a) => ${D}.read(...a); export const writeCachedNotes = (...a) => ${D}.write(...a);`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) {
      return { format: "module", source: DOUBLES[url.slice("double:".length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const ROUTES = {
  translate: () => import("../../app/api/translate/route"),
  "word/text": () => import("../../app/api/word/text/route"),
  "word/unlisted": () => import("../../app/api/word/unlisted/route"),
  "phrase/notes": () => import("../../app/api/phrase/notes/route"),
};
const BODIES: Record<keyof typeof ROUTES, unknown> = {
  translate: { text: "Hello there." },
  "word/text": { headword: "run", needDefinition: true },
  "word/unlisted": { word: "zzqxv" },
  "phrase/notes": { source: "the cat sat", translation: "el gato se sentó" },
};

function post(route: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`https://wordbook.test/api/${route}`, {
    method: "POST",
    headers: { host: "wordbook.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  calls.length = 0;
});

for (const route of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
  test(`${route}: a foreign Origin is refused 403 with nothing claimed`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(
      post(route, { "content-type": "text/plain", origin: "https://evil.test" }, JSON.stringify(BODIES[route])),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`${route}: a foreign Origin is refused even with a JSON body`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(post(route, { "content-type": "application/json", origin: "https://evil.test" }, BODIES[route]));
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  test(`${route}: text/plain from the own origin is refused 415 with nothing claimed`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(
      post(route, { "content-type": "text/plain", origin: "https://wordbook.test" }, JSON.stringify(BODIES[route])),
    );
    assert.equal(response.status, 415);
    assert.deepEqual(calls, []);
  });

  test(`${route}: no Content-Type at all is refused 415`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(post(route, {}, JSON.stringify(BODIES[route])));
    assert.equal(response.status, 415);
    assert.deepEqual(calls, []);
  });

  test(`${route}: same-origin JSON passes the guard`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(
      post(route, { "content-type": "application/json; charset=utf-8", origin: "https://wordbook.test" }, BODIES[route]),
    );
    assert.ok(response.status !== 403 && response.status !== 415, `guard refused: ${response.status}`);
  });

  test(`${route}: JSON with no Origin (a non-browser caller) passes the guard`, async () => {
    const { POST } = await ROUTES[route]();
    const response = await POST(post(route, { "content-type": "application/json" }, BODIES[route]));
    assert.ok(response.status !== 403 && response.status !== 415);
  });
}
