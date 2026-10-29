import assert from "node:assert/strict";
import test from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import { landingAfterSignIn, verifyMagicLink } from "./verify-magic-link";

// RP-18: the link is verified once. `verifyOtp` spends the token, so a second
// call after a timeout would turn an unknown into a certain failure.

const params = { type: "magiclink", token_hash: "h" };

test("a user in the answer is a success, and verifyOtp ran once with the params", async () => {
  const calls: unknown[] = [];
  const result = await verifyMagicLink(async (p: typeof params) => {
    calls.push(p);
    return { data: { user: { id: "u1" } }, error: null };
  }, params);
  assert.deepEqual(result, { ok: true, user: { id: "u1" } });
  assert.deepEqual(calls, [params]);
});

test("a gateway that did not answer is linkTimeout, and is never retried", async () => {
  let calls = 0;
  const result = await verifyMagicLink(async () => {
    calls += 1;
    return { data: { user: null }, error: new AuthRetryableFetchError("gateway", 504) };
  }, params);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "linkTimeout");
  assert.equal(calls, 1);
});

test("a completed rejection is linkInvalid, never linkTimeout, and its detail keeps the status and code", async () => {
  let calls = 0;
  const result = await verifyMagicLink(async () => {
    calls += 1;
    return { data: { user: null }, error: new AuthApiError("expired", 403, "otp_expired") };
  }, params);
  assert.ok(!result.ok);
  assert.equal(result.reason, "linkInvalid");
  assert.match(result.detail, /403/);
  assert.match(result.detail, /otp_expired/);
  assert.equal(calls, 1);
});

test("an answer with no error and no user is not a sign-in", async () => {
  const result = await verifyMagicLink(async () => ({ data: { user: null }, error: null }), params);
  assert.ok(!result.ok);
  assert.equal(result.reason, "linkInvalid");
});

test("an error that arrives with a user is still a failure", async () => {
  const result = await verifyMagicLink(
    async () => ({ data: { user: { id: "u1" } }, error: new AuthApiError("x", 400, "bad") }),
    params,
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, "linkInvalid");
});

test("landingAfterSignIn returns to the consent and to / for anything else", () => {
  const site = "https://pulsar.example";
  assert.equal(landingAfterSignIn("/oauth/autorizar?client_id=a", site), "/oauth/autorizar?client_id=a");
  for (const next of ["//evil.example", "https://evil.example/oauth/autorizar", "/metas", "", null, undefined]) {
    assert.equal(landingAfterSignIn(next, site), "/", String(next));
  }
});
