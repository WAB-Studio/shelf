import assert from "node:assert/strict";
import test from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import { verifyCode } from "./verify-code";

// RP-136: a typed code is verified once. `verifyOtp` spends the code, so a second call after a
// timeout would turn an unknown into a certain failure on the person's behalf.

const pair = { email: "ana@correo.test", code: "123456" };
const asked = { email: "ana@correo.test", token: "123456", type: "email" };

function spy(answer: { data: { user: { id: string } | null }; error: unknown }) {
  const calls: unknown[] = [];
  const verifyOtp = async (params: unknown) => {
    calls.push(params);
    return answer;
  };
  return { calls, verifyOtp };
}

test("a user in the answer is a success, asked once with the address, the code as token and type email", async () => {
  const { calls, verifyOtp } = spy({ data: { user: { id: "u1" } }, error: null });
  const result = await verifyCode(verifyOtp, pair);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.user, { id: "u1" });
  assert.deepEqual(calls, [asked]);
});

test("a gateway that did not answer is codeTimeout, and is never asked again", async () => {
  const { calls, verifyOtp } = spy({ data: { user: null }, error: new AuthRetryableFetchError("Gateway Timeout", 504) });
  const result = await verifyCode(verifyOtp, pair);
  assert.equal(!result.ok && result.reason, "codeTimeout");
  assert.deepEqual(calls, [asked]);
});

test("a wrong or expired code is codeInvalid, asked once", async () => {
  const { calls, verifyOtp } = spy({
    data: { user: null },
    error: new AuthApiError("Token has expired or is invalid", 403, "otp_expired"),
  });
  const result = await verifyCode(verifyOtp, pair);
  assert.equal(!result.ok && result.reason, "codeInvalid");
  assert.equal(calls.length, 1);
});

test("an answer with no error and no user is codeInvalid", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: null });
  const result = await verifyCode(verifyOtp, pair);
  assert.equal(!result.ok && result.reason, "codeInvalid");
});

test("a rate limit is its own reason, neither codeInvalid nor codeTimeout", async () => {
  const { calls, verifyOtp } = spy({
    data: { user: null },
    error: new AuthApiError("For security purposes, you can only request this after 30 seconds.", 429, "over_request_rate_limit"),
  });
  const result = await verifyCode(verifyOtp, pair);
  assert.equal(result.ok, false);
  const reason: string | false = !result.ok && result.reason;
  assert.ok(reason === "rateLimited" || reason === "codeRateLimited", `rate limit read as ${String(reason)}`);
  assert.equal(calls.length, 1);
});
