import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizationServerResponse, discoveryPreflight, resourceMetadataResponse } from "./discovery";
import { registrationPreflight, registrationResponse } from "./register";

const ISSUER = "https://our-piggy-bank.test";

test("the authorization server document names this host's endpoints and only the PKCE code flow", async () => {
  const response = authorizationServerResponse(ISSUER);
  const document = await response.json();
  assert.equal(document.issuer, ISSUER);
  assert.equal(document.authorization_endpoint, `${ISSUER}/oauth/authorize`);
  assert.equal(document.token_endpoint, `${ISSUER}/oauth/token`);
  assert.equal(document.registration_endpoint, `${ISSUER}/oauth/register`);
  assert.deepEqual(document.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(document.grant_types_supported, ["authorization_code"]);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("the resource document points at the same issuer the server document carries", async () => {
  const document = await resourceMetadataResponse(ISSUER).json();
  assert.equal(document.resource, `${ISSUER}/mcp`);
  assert.deepEqual(document.authorization_servers, [ISSUER]);
});

test("each discovery and registration preflight is 204 with no credentials", () => {
  for (const response of [discoveryPreflight(), registrationPreflight()]) {
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
  }
});

test("registration answers a public client and hands the store what it validated", async () => {
  const seen: unknown[] = [];
  const uris = ["https://claude.ai/api/mcp/auth_callback"];
  const response = await registrationResponse({ client_name: "Claude", redirect_uris: uris, junk: 1 }, async (input) => {
    seen.push(input);
    return "id-1";
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(seen, [{ name: "Claude", redirectUris: uris }]);
  assert.deepEqual(await response.json(), {
    client_id: "id-1",
    client_name: "Claude",
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
});

test("a client that asks for a secret method is answered as the public client it is", async () => {
  const response = await registrationResponse(
    { client_name: "Claude", redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "client_secret_basic" },
    async () => "id-2",
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).token_endpoint_auth_method, "none");
});

test("registration refuses a body the schema refuses, and stores nothing", async () => {
  const seen: unknown[] = [];
  const store = async (input: unknown) => (seen.push(input), "id");
  for (const body of [null, {}, { client_name: "x", redirect_uris: ["http://evil.example/cb"] }]) {
    const response = await registrationResponse(body, store);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_client_metadata" });
  }
  assert.equal(seen.length, 0);
});
