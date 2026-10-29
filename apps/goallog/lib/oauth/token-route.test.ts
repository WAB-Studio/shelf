import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

const CLIENT = "0b9b3a52-6a8e-4f0e-9c58-5f4a5b6a8f10";
const METADATA_URL = "https://known.example/client.json";
const STORED = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const TTL = 1234;

const metadataCalls: string[] = [];
const grantCalls: { kind: string; input: Record<string, unknown> }[] = [];
let granted = true;

// The route claims its call first; this file proves what follows an admitted one.
mock.module("@/db/client", { namedExports: { db: { execute: async () => [{ wait: 0 }] } } });
mock.module("@/lib/oauth/client-metadata", {
  namedExports: {
    clientFromMetadataUrl: async (url: string) => {
      metadataCalls.push(url);
      return url === METADATA_URL ? { id: STORED, name: "known", redirectUris: [] } : null;
    },
  },
});
mock.module("@/lib/oauth/grants", {
  namedExports: {
    exchangeCode: async (input: Record<string, unknown>) => {
      grantCalls.push({ kind: "code", input });
      return granted ? { personId: "p", accessToken: "plo_a", refreshToken: "plr_b", expiresIn: TTL } : null;
    },
    refreshToken: async (input: Record<string, unknown>) => {
      grantCalls.push({ kind: "refresh", input });
      return granted ? { personId: "p", accessToken: "plo_c", refreshToken: "plr_d", expiresIn: TTL } : null;
    },
  },
});

let route: typeof import("@/app/oauth/token/route");

before(async () => {
  route = await import("@/app/oauth/token/route");
});

beforeEach(() => {
  metadataCalls.length = 0;
  grantCalls.length = 0;
  granted = true;
});

const call = (fields: Record<string, string>) =>
  route.POST(
    new Request("http://x.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );

const code = (client_id: string) => ({
  grant_type: "authorization_code",
  code: "plc_x",
  code_verifier: "v".repeat(43),
  client_id,
  redirect_uri: "http://localhost:6274/cb",
});
const refresh = (client_id: string) => ({ grant_type: "refresh_token", refresh_token: "plr_x", client_id });

test("a uuid client_id reaches both grants as it is, with no metadata lookup", async () => {
  await call(code(CLIENT));
  await call(refresh(CLIENT));
  assert.deepEqual(grantCalls.map((entry) => entry.input.clientId), [CLIENT, CLIENT]);
  assert.deepEqual(metadataCalls, []);
});

test("an https client_id reaches both grants as the id its metadata document stored", async () => {
  const exchanged = await call(code(METADATA_URL));
  const refreshed = await call(refresh(METADATA_URL));
  assert.equal(exchanged.status, 200);
  assert.equal(refreshed.status, 200);
  assert.deepEqual(grantCalls.map((entry) => entry.input.clientId), [STORED, STORED]);
  assert.deepEqual(metadataCalls, [METADATA_URL, METADATA_URL]);
});

test("an https client_id nobody knows is invalid_grant and no grant runs", async () => {
  for (const fields of [code("https://stranger.example/c.json"), refresh("https://stranger.example/c.json")]) {
    const response = await call(fields);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
  }
  assert.deepEqual(grantCalls, []);
});

test("an http or garbage client_id is invalid_grant without a lookup or a grant", async () => {
  for (const id of ["http://known.example/client.json", "not-a-client", "ftp://x.example/c"]) {
    for (const fields of [code(id), refresh(id)]) {
      const response = await call(fields);
      assert.equal(response.status, 400, id);
      assert.deepEqual(await response.json(), { error: "invalid_grant" }, id);
    }
  }
  assert.deepEqual(metadataCalls, []);
  assert.deepEqual(grantCalls, []);
});

test("a grant that finds nothing is invalid_grant, on both grants", async () => {
  granted = false;
  for (const fields of [code(CLIENT), refresh(CLIENT)]) {
    const response = await call(fields);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
  }
});

test("the tokens answer carries the grant's own expiry, and never a constant", async () => {
  const response = await call(code(CLIENT));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    access_token: "plo_a",
    token_type: "Bearer",
    expires_in: TTL,
    refresh_token: "plr_b",
  });
  assert.equal((await (await call(refresh(CLIENT))).json()).expires_in, TTL);
});

test("a refresh without refresh_token, and a code grant without a code, are invalid_request", async () => {
  for (const fields of [
    { grant_type: "refresh_token", client_id: CLIENT },
    { grant_type: "authorization_code", client_id: CLIENT },
    { grant_type: "authorization_code", ...{ code: "c", code_verifier: "v", client_id: CLIENT } },
  ]) {
    const response = await call(fields);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  assert.deepEqual(grantCalls, []);
});

test("an unknown grant_type is unsupported_grant_type", async () => {
  const response = await call({ grant_type: "password", client_id: CLIENT });
  assert.deepEqual([response.status, await response.json()], [400, { error: "unsupported_grant_type" }]);
});

test("every answer is uncacheable and open to any origin", async () => {
  for (const response of [await call(code(CLIENT)), await call({ grant_type: "x" })]) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
});

test("the preflight is 204 for any origin, allows POST, and grants no credentials", () => {
  const response = route.OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});
