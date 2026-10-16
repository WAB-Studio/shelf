// `askLate` sorts every outcome of a late request into the three that matter
// to a cache: an answer, a deliberate absence, and a failure to reach.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";

import { askLate, remembers, type LateResult } from "./late-answer";

const schema = z.object({ ok: z.literal(true) });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => respond()) as typeof fetch;
}

function ask(): Promise<LateResult<{ ok: true }>> {
  return askLate("/api/x", { a: 1 }, schema, new AbortController().signal);
}

test("200 with a body the schema accepts resolves", async () => {
  stubFetch(() => Response.json({ ok: true }));
  assert.deepEqual(await ask(), { kind: "resolved", value: { ok: true } });
});

test("204 is declined", async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await ask(), { kind: "declined" });
});

test("400 is declined", async () => {
  stubFetch(() => new Response(null, { status: 400 }));
  assert.deepEqual(await ask(), { kind: "declined" });
});

test("503 is unreached", async () => {
  stubFetch(() => new Response(null, { status: 503 }));
  assert.deepEqual(await ask(), { kind: "unreached" });
});

test("a rejected fetch is unreached", async () => {
  stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  assert.deepEqual(await ask(), { kind: "unreached" });
});

test("200 whose body fails the schema is unreached", async () => {
  stubFetch(() => Response.json({ ok: false }));
  assert.deepEqual(await ask(), { kind: "unreached" });
});

test("200 whose body is not JSON is unreached", async () => {
  stubFetch(() => new Response("<html>", { status: 200 }));
  assert.deepEqual(await ask(), { kind: "unreached" });
});

test("the request is a JSON POST carrying the body and the signal", async () => {
  let seen: { url: unknown; init: RequestInit | undefined } | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const controller = new AbortController();
  await askLate("/api/x", { a: 1 }, schema, controller.signal);
  assert.equal(seen!.url, "/api/x");
  assert.equal(seen!.init?.method, "POST");
  assert.equal(seen!.init?.body, JSON.stringify({ a: 1 }));
  assert.equal(seen!.init?.signal, controller.signal);
});

test("remembers is true for resolved and declined alone", () => {
  assert.equal(remembers({ kind: "resolved", value: 1 }), true);
  assert.equal(remembers({ kind: "declined" }), true);
  assert.equal(remembers({ kind: "unreached" }), false);
});
