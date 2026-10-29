// RL-73: a typed code is verified once, and a refusal says whether the code is
// wrong or expired, Auth's own limit, or our side not answering. `verifyOtp` is
// a spy: every count is a real invocation, and nothing here reaches Auth.
import assert from "node:assert/strict";
import test from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import { verifyCode } from "./verify-code";

type Params = { email: string; token: string; type: string };
type User = { id: string; email: string };

const EMAIL = "lectora@example.com";
const USER: User = { id: "00000000-0000-4000-8000-000000000073", email: EMAIL };

function spy(answer: { data: { user: User | null }; error: unknown }) {
  const calls: Params[] = [];
  const verifyOtp = async (params: Params) => {
    calls.push(params);
    return answer;
  };
  return { calls, verifyOtp };
}

// Mutation: `type: "magiclink"`, `token_hash` for `token`, the email left out, or a second call.
test("a code asks Auth exactly once, as an email code for that address, and lets the reader in", async () => {
  const { calls, verifyOtp } = spy({ data: { user: USER }, error: null });
  const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(calls, [{ email: EMAIL, token: "123456", type: "email" }]);
  assert.equal(result.ok, true);
});

// Mutation: map every error to codeTimeout or rateLimited.
test("a wrong or expired code (otp_expired) reads as codeInvalid, asked once", async () => {
  const { calls, verifyOtp } = spy({
    data: { user: null },
    error: new AuthApiError("Token has expired or is invalid", 403, "otp_expired"),
  });
  const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
  assert.equal(calls.length, 1);
});

// Mutation: collapse every failure to codeInvalid (the retryable branch dropped).
test("Auth not answering (a retryable 504) reads as codeTimeout", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: new AuthRetryableFetchError("Gateway Timeout", 504) });
  const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeTimeout" });
});

// Mutation: a retry on a retryable error (the code may already be spent: docs/TRAPS.md, linkInvalid is a 504).
test("a retryable error is never answered by asking Auth a second time", async () => {
  for (const error of [
    new AuthRetryableFetchError("Gateway Timeout", 504),
    new AuthRetryableFetchError("Service Unavailable", 503),
    new AuthRetryableFetchError("fetch failed", 0),
  ]) {
    const { calls, verifyOtp } = spy({ data: { user: null }, error });
    await verifyCode(verifyOtp, { email: EMAIL, code: "654321" });
    assert.equal(calls.length, 1, `asked ${calls.length} times on ${error.message}`);
  }
});

// Mutation: collapse to codeInvalid (the 429 branch dropped).
test("a 429 from Auth reads as rateLimited", async () => {
  for (const error of [{ status: 429 }, new AuthApiError("Too many requests", 429, "over_request_rate_limit")]) {
    const { calls, verifyOtp } = spy({ data: { user: null }, error });
    const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
    assert.deepEqual(result, { ok: false, reason: "rateLimited" }, `on ${JSON.stringify(error)}`);
    assert.equal(calls.length, 1);
  }
});

// Mutation: test only `error`, so an answer with no user passes as a session.
test("an answer with no error and no user does not let the reader in", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: null });
  const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
});

// Mutation: read any server error as rateLimited or codeTimeout (`status >= 400`, `status >= 500`).
test("any other refusal from Auth reads as codeInvalid", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: new AuthApiError("Database error", 500, "unexpected_failure") });
  const result = await verifyCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
});

// Property: whatever Auth answers, it is asked once per code, with that code. Mutation: a retry loop on any failure.
test("whatever Auth answers, it is asked exactly once with the code typed", async () => {
  const answers: unknown[] = [
    null,
    new AuthApiError("expired", 403, "otp_expired"),
    new AuthRetryableFetchError("Gateway Timeout", 504),
    { status: 429 },
    new AuthApiError("boom", 500, undefined),
    new Error("socket hang up"),
  ];
  for (const error of answers) {
    const { calls, verifyOtp } = spy({ data: { user: error === null ? USER : null }, error });
    await verifyCode(verifyOtp, { email: EMAIL, code: "000731" });
    assert.deepEqual(calls, [{ email: EMAIL, token: "000731", type: "email" }], `on ${String(error)}`);
  }
});
