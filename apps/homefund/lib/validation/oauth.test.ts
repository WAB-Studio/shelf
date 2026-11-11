import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizationRequestSchema, redirectBack } from "./oauth";

const schema = authorizationRequestSchema(["https://homefund.test", "https://our-piggy-bank.vercel.app"]);

const request = {
  response_type: "code",
  client_id: "0b9b3a52-6a8e-4f0e-9c58-5f4a5b6a8f10",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "abc",
};

test("a PKCE code request passes, with or without a resource, and scope is dropped", () => {
  assert.equal(schema.safeParse(request).success, true);
  const parsed = schema.parse({ ...request, resource: "https://homefund.test/mcp", scope: "x" });
  assert.equal("scope" in parsed, false);
});

test("the resource may carry a trailing slash and may name either host this app serves", () => {
  for (const resource of [
    "https://homefund.test/mcp",
    "https://homefund.test/mcp/",
    "https://our-piggy-bank.vercel.app/mcp",
    "https://our-piggy-bank.vercel.app/mcp/",
  ]) {
    assert.equal(schema.safeParse({ ...request, resource }).success, true, resource);
  }
  for (const resource of ["https://evil.example/mcp", "https://homefund.test/other", "https://homefund.test/mcp//", "http://homefund.test/mcp"]) {
    assert.equal(schema.safeParse({ ...request, resource }).success, false, resource);
  }
});

test("a request that is not S256, not a code, or for another audience is refused", () => {
  for (const change of [
    { code_challenge_method: "plain" },
    { response_type: "token" },
    { code_challenge: "short" },
    { client_id: "https://evil.example/client.json" },
  ]) {
    assert.equal(schema.safeParse({ ...request, ...change }).success, false, JSON.stringify(change));
  }
});

test("the way back carries the code and the client's own state", () => {
  const back = new URL(redirectBack(schema.parse(request), { code: "hfc_1", iss: "https://our-piggy-bank.test" }));
  assert.equal(back.origin + back.pathname, request.redirect_uri);
  assert.equal(back.searchParams.get("code"), "hfc_1");
  assert.equal(back.searchParams.get("state"), "abc");
});
