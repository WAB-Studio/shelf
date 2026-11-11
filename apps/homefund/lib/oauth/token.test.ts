import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenResponse, type Exchange } from "./token";

const CLIENT = "0b9b3a52-6a8e-4f0e-9c58-5f4a5b6a8f10";

const form = (fields: Record<string, string>) => new URLSearchParams(fields) as unknown as FormData;

const fields = {
  grant_type: "authorization_code",
  code: "hfc_x",
  code_verifier: "v".repeat(43),
  client_id: CLIENT,
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
};

function recording(answer: string | null) {
  const calls: Parameters<Exchange>[0][] = [];
  const exchange: Exchange = async (input) => {
    calls.push(input);
    return answer;
  };
  return { calls, exchange };
}

test("a good exchange answers the bearer, uncached, with no refresh token", async () => {
  const { calls, exchange } = recording("whk_abc");
  const response = await tokenResponse(form(fields), exchange);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { access_token: "whk_abc", token_type: "Bearer" });
  assert.deepEqual(calls, [{ code: "hfc_x", verifier: fields.code_verifier, clientId: CLIENT, redirectUri: fields.redirect_uri }]);
});

// Wrong verifier, expired, reused, another client or another redirect all come back from the exchange as null.
test("every refused exchange is the same invalid_grant", async () => {
  const response = await tokenResponse(form(fields), recording(null).exchange);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_grant" });
});

test("a malformed request never reaches the exchange", async () => {
  const { calls, exchange } = recording("whk_abc");
  const missing: Record<string, string> = { ...fields };
  delete missing.code_verifier;
  assert.equal((await tokenResponse(form(missing), exchange)).status, 400);
  assert.equal((await tokenResponse(form({ ...fields, client_id: "https://x.example/c.json" }), exchange)).status, 400);
  assert.equal((await tokenResponse(null, exchange)).status, 400);
  assert.equal(calls.length, 0);
});

test("a grant type other than the code grant is unsupported", async () => {
  const response = await tokenResponse(form({ grant_type: "refresh_token", refresh_token: "x", client_id: CLIENT }), recording("t").exchange);
  assert.deepEqual(await response.json(), { error: "unsupported_grant_type" });
});

test("a database failure answers OAuth JSON with the CORS headers, not an HTML 500", async () => {
  const response = await tokenResponse(form(fields), async () => {
    throw new Error("connection ended");
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { error: "server_error" });
});
