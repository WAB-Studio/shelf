import assert from "node:assert/strict";
import test from "node:test";

import { redirectAllowed, registrationSchema } from "./clients";

const body = (redirect_uris: string[]) => ({ client_name: "Claude", redirect_uris });

test("each allowed redirect form passes", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost/cb",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:8080/cb",
  ]) {
    assert.equal(registrationSchema.safeParse(body([uri])).success, true, uri);
  }
});

test("each refused redirect form is refused", () => {
  for (const uri of [
    "http://evil.example/cb",
    "https://claude.ai/cb#frag",
    "javascript:alert(1)",
    "http://localhost.evil.example/cb",
    "http://localhost@evil.example/cb",
    "ftp://localhost/cb",
    "not a url",
  ]) {
    assert.equal(registrationSchema.safeParse(body([uri])).success, false, uri);
  }
});

test("the redirect count runs from 1 to 5", () => {
  const uri = "https://a.example/cb";
  assert.equal(registrationSchema.safeParse(body([])).success, false);
  assert.equal(registrationSchema.safeParse(body(Array(5).fill(uri))).success, true);
  assert.equal(registrationSchema.safeParse(body(Array(6).fill(uri))).success, false);
});

test("the name runs from 1 to 80 characters", () => {
  const uris = ["https://a.example/cb"];
  assert.equal(registrationSchema.safeParse({ client_name: "", redirect_uris: uris }).success, false);
  assert.equal(registrationSchema.safeParse({ client_name: "x".repeat(80), redirect_uris: uris }).success, true);
  assert.equal(registrationSchema.safeParse({ client_name: "x".repeat(81), redirect_uris: uris }).success, false);
});

test("only the none auth method passes, and grants without the code grant are refused", () => {
  const base = body(["https://a.example/cb"]);
  assert.equal(registrationSchema.safeParse({ ...base, token_endpoint_auth_method: "none" }).success, true);
  assert.equal(registrationSchema.safeParse({ ...base, token_endpoint_auth_method: "client_secret_basic" }).success, false);
  assert.equal(registrationSchema.safeParse({ ...base, grant_types: ["authorization_code", "refresh_token"] }).success, true);
  assert.equal(registrationSchema.safeParse({ ...base, grant_types: ["password"] }).success, false);
});

test("a redirect matches only as the whole registered string", () => {
  const client = { redirectUris: ["https://a.example/cb"] };
  assert.equal(redirectAllowed(client, "https://a.example/cb"), true);
  assert.equal(redirectAllowed(client, "https://a.example/cb/evil"), false);
  assert.equal(redirectAllowed(client, "https://a.example/c"), false);
  assert.equal(redirectAllowed(client, "https://a.example/cb?x=1"), false);
  assert.equal(redirectAllowed(client, "https://a.example/cb/"), false);
  assert.equal(redirectAllowed(client, "https://A.example/cb"), false);
  assert.equal(redirectAllowed(client, "https://a.example/CB"), false);
});

test("a grant the server does not offer is ignored; the code grant is required", () => {
  const uri = "https://claude.ai/api/mcp/auth_callback";
  const claude = ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"];
  assert.equal(registrationSchema.safeParse({ ...body([uri]), grant_types: claude }).success, true);
  assert.equal(registrationSchema.safeParse({ ...body([uri]), grant_types: ["refresh_token"] }).success, false);
  assert.equal(registrationSchema.safeParse({ ...body([uri]), grant_types: [] }).success, false);
});
