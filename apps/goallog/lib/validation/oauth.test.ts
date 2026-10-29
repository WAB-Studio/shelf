import assert from "node:assert/strict";
import test from "node:test";

import { authorizationErrorKey, authorizationRequestSchema, consentReturnPath } from "./oauth";

const SITE = "https://pulsar.example";
const good = {
  response_type: "code",
  client_id: "6f1c1b7e-2d4a-4f3b-9c8e-1a2b3c4d5e6f",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "abc",
  resource: `${SITE}/mcp`,
};

const refusal = (patch: Record<string, unknown>) => authorizationErrorKey({ ...good, ...patch }, SITE);

test("a complete request passes and scope is dropped", () => {
  assert.equal(authorizationErrorKey(good, SITE), null);
  const parsed = authorizationRequestSchema(SITE).parse({ ...good, scope: "anything" });
  assert.equal("scope" in parsed, false);
});

test("a client named by an https URL passes, an http one does not", () => {
  assert.equal(refusal({ client_id: "https://claude.ai/oauth/client.json" }), null);
  assert.equal(refusal({ client_id: "http://claude.ai/client.json" }), "oauth.errors.clientId");
});

test("each field refuses with its own key", () => {
  assert.equal(refusal({ response_type: "token" }), "oauth.errors.responseType");
  assert.equal(refusal({ client_id: "nope" }), "oauth.errors.clientId");
  assert.equal(refusal({ client_id: undefined }), "oauth.errors.clientId");
  assert.equal(refusal({ redirect_uri: "not a url" }), "oauth.errors.redirectUri");
  assert.equal(refusal({ redirect_uri: undefined }), "oauth.errors.redirectUri");
  assert.equal(refusal({ code_challenge: "" }), "oauth.errors.codeChallenge");
  assert.equal(refusal({ code_challenge: undefined }), "oauth.errors.codeChallenge");
  assert.equal(refusal({ code_challenge_method: "plain" }), "oauth.errors.codeChallengeMethod");
  assert.equal(refusal({ code_challenge_method: undefined }), "oauth.errors.codeChallengeMethod");
  assert.equal(refusal({ state: "s".repeat(501) }), "oauth.errors.state");
  assert.equal(refusal({ state: "s".repeat(500) }), null);
});

test("a resource that is not this server's /mcp is refused, even a near one", () => {
  for (const resource of [
    "https://evil.example/mcp",
    `${SITE}/mcp/`,
    `${SITE}`,
    `${SITE}/mcpx`,
    `${SITE}.evil.example/mcp`,
    undefined,
  ]) {
    assert.equal(refusal({ resource }), "oauth.errors.resource", String(resource));
  }
});

test("a trailing slash on the site URL still names /mcp once", () => {
  assert.equal(authorizationErrorKey(good, `${SITE}/`), null);
});

test("a body that is not an object is invalid", () => {
  for (const input of [null, undefined, "code", 7]) {
    assert.equal(authorizationErrorKey(input, SITE), "oauth.errors.invalid");
  }
});

test("consentReturnPath keeps the consent and its query", () => {
  assert.equal(consentReturnPath("/oauth/autorizar", SITE), "/oauth/autorizar");
  assert.equal(
    consentReturnPath("/oauth/autorizar?client_id=a&state=b%20c", SITE),
    "/oauth/autorizar?client_id=a&state=b%20c",
  );
});

test("consentReturnPath refuses every other destination", () => {
  for (const next of [
    "//evil.example",
    "//evil.example/oauth/autorizar",
    "https://evil.example/oauth/autorizar",
    `${SITE}/oauth/autorizar`,
    "/\\evil.example",
    "/\\/evil.example/oauth/autorizar",
    "/metas",
    "/",
    "",
    "oauth/autorizar",
    "/oauth/autorizarx",
    "/oauth/autorizar/otro",
    "/oauth/autorizar/../../metas",
    "/oauth/autorizar/../metas",
    "javascript:alert(1)",
    null,
    undefined,
  ]) {
    assert.equal(consentReturnPath(next, SITE), null, String(next));
  }
});

test("a code_challenge has exactly 43 characters", () => {
  const challenge = good.code_challenge;
  assert.equal(challenge.length, 43);
  assert.equal(refusal({ code_challenge: challenge.slice(1) }), "oauth.errors.codeChallenge");
  assert.equal(refusal({ code_challenge: `${challenge}A` }), "oauth.errors.codeChallenge");
  assert.equal(refusal({ code_challenge: challenge }), null);
});

test("an https client_id that is no URL is refused", () => {
  assert.equal(refusal({ client_id: "https://" }), "oauth.errors.clientId");
  assert.equal(refusal({ client_id: "https://[" }), "oauth.errors.clientId");
});
