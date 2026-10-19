import assert from "node:assert/strict";
import { test } from "node:test";
import { refuseCrossSite } from "./same-origin";

const make = (headers: Record<string, string>) =>
  new Request("https://goallog.test/api/x", { method: "POST", headers, body: "{}" });
const json = { "content-type": "application/json", host: "goallog.test" };

async function refusal(response: Response | null, status: number, error: string) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error });
}

test("a foreign origin is refused with 403", async () => {
  await refusal(refuseCrossSite(make({ ...json, origin: "https://evil.example" }), "json"), 403, "forbidden");
  await refusal(refuseCrossSite(make({ ...json, origin: "http://goallog.test.evil.example" }), "json"), 403, "forbidden");
});

test("the own origin goes on", () => {
  assert.equal(refuseCrossSite(make({ ...json, origin: "https://goallog.test" }), "json"), null);
});

test("the first forwarded host is the own host", () => {
  const headers = { ...json, "x-forwarded-host": "a.test, b.test" };
  assert.equal(refuseCrossSite(make({ ...headers, origin: "https://a.test" }), "json"), null);
  assert.equal(refuseCrossSite(make({ ...headers, origin: "https://b.test" }), "json")?.status, 403);
});

test("an unparseable origin is foreign", async () => {
  await refusal(refuseCrossSite(make({ ...json, origin: "null" }), "json"), 403, "forbidden");
});

test("a json route refuses a body that is not json", async () => {
  for (const type of ["text/plain", "text/json-ish", "application/jsonx", "application/x-www-form-urlencoded", ""]) {
    await refusal(refuseCrossSite(make({ host: "goallog.test", "content-type": type }), "json"), 415, "unsupportedMediaType");
  }
  assert.equal(refuseCrossSite(make({ host: "goallog.test", "content-type": "application/json; charset=utf-8" }), "json"), null);
});

test("a multipart route takes multipart/form-data alone", async () => {
  const host = "goallog.test";
  assert.equal(refuseCrossSite(make({ host, "content-type": "multipart/form-data; boundary=x" }), "multipart"), null);
  await refusal(refuseCrossSite(make({ host, "content-type": "application/x-www-form-urlencoded" }), "multipart"), 415, "unsupportedMediaType");
  await refusal(refuseCrossSite(make({ host, "content-type": "multipart/mixed; boundary=x" }), "multipart"), 415, "unsupportedMediaType");
  await refusal(refuseCrossSite(make({ host, "content-type": "application/json" }), "multipart"), 415, "unsupportedMediaType");
});

test("no origin passes to the type check", async () => {
  assert.equal(refuseCrossSite(make(json), "json"), null);
  await refusal(refuseCrossSite(make({ host: "goallog.test", "content-type": "text/plain" }), "json"), 415, "unsupportedMediaType");
});
