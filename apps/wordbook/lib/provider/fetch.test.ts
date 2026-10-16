// providerFetch with a simulated `fetch`: no network, no key.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { providerFetch } from "./fetch";

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  console.error = realError;
});

function captureLogs(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  return lines;
}

test("a fetch that never resolves returns null within the timeout", async () => {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const lines = captureLogs();
  const started = Date.now();
  // AbortSignal.timeout's timer is unref'd: hold the loop open until it fires.
  const keepAlive = setInterval(() => {}, 10);
  const result = await providerFetch("https://x.invalid", {}, { name: "openai-text", timeoutMs: 50 });
  clearInterval(keepAlive);
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(lines, ["[provider] openai-text timeout"]);
});

test("a non-OK status returns null and logs the name and status", async () => {
  globalThis.fetch = (async () => new Response("secret body", { status: 429 })) as typeof fetch;
  const lines = captureLogs();
  const result = await providerFetch("https://x.invalid", {}, { name: "openai-text" });
  assert.equal(result, null);
  assert.deepEqual(lines, ["[provider] openai-text 429"]);
});

test("the log never carries the key or the request body", async () => {
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  const lines = captureLogs();
  await providerFetch(
    "https://x.invalid",
    { method: "POST", headers: { authorization: "Bearer sk-secret" }, body: "reader text" },
    { name: "openai-notes" },
  );
  const logged = lines.join("\n");
  assert.ok(!logged.includes("sk-secret"));
  assert.ok(!logged.includes("reader text"));
});

test("a dropped network returns null and logs network", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const lines = captureLogs();
  assert.equal(await providerFetch("https://x.invalid", {}, { name: "openai-unlisted" }), null);
  assert.deepEqual(lines, ["[provider] openai-unlisted network"]);
});

test("an OK response passes through as the same Response", async () => {
  const ok = new Response("{}", { status: 200 });
  globalThis.fetch = (async () => ok) as typeof fetch;
  const lines = captureLogs();
  assert.equal(await providerFetch("https://x.invalid", {}, { name: "openai-text" }), ok);
  assert.deepEqual(lines, []);
});

test("the request's method, headers and body reach fetch, with an abort signal added", async () => {
  const seen: { url: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const headers = { authorization: "Bearer k", "content-type": "application/json" };
  await providerFetch("https://x.invalid/a", { method: "POST", headers, body: '{"q":1}' }, { name: "openai-text" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://x.invalid/a");
  assert.equal(seen[0].init?.method, "POST");
  assert.deepEqual(seen[0].init?.headers, headers);
  assert.equal(seen[0].init?.body, '{"q":1}');
  assert.ok(seen[0].init?.signal instanceof AbortSignal);
});

test("without timeoutMs the request is bounded at 20 seconds", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const timeout = mock.method(AbortSignal, "timeout");
  await providerFetch("https://x.invalid", {}, { name: "openai-text" });
  assert.equal(timeout.mock.callCount(), 1);
  assert.deepEqual(timeout.mock.calls[0].arguments, [20_000]);
});
