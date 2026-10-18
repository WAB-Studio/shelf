import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import { verifyMagicLink } from "./verify-magic-link";

const USER = { id: "u1" };

function spy<TUser>(answer: { data: { user: TUser | null }; error: unknown }) {
  const seen: unknown[] = [];
  const verifyOtp = async (params: unknown) => {
    seen.push(params);
    return answer;
  };
  return { seen, verifyOtp };
}

test("an answer with no user and no error is linkInvalid, asked once", async () => {
  const { seen, verifyOtp } = spy({ data: { user: null }, error: null });
  const result = await verifyMagicLink(verifyOtp, { token_hash: "t" });
  assert.deepEqual(result, { ok: false, reason: "linkInvalid" });
  assert.equal(seen.length, 1);
});

test("an answer with a user and an error is linkInvalid, asked once", async () => {
  const { seen, verifyOtp } = spy({
    data: { user: USER },
    error: new AuthApiError("expired", 403, "otp_expired"),
  });
  const result = await verifyMagicLink(verifyOtp, { token_hash: "t" });
  assert.deepEqual(result, { ok: false, reason: "linkInvalid" });
  assert.equal(seen.length, 1);
});

test("a retryable fetch error is linkTimeout, asked once", async () => {
  const { seen, verifyOtp } = spy({
    data: { user: null },
    error: new AuthRetryableFetchError("fetch failed", 0),
  });
  const result = await verifyMagicLink(verifyOtp, { token_hash: "t" });
  assert.deepEqual(result, { ok: false, reason: "linkTimeout" });
  assert.equal(seen.length, 1);
});

test("a user with no error is ok, asked once", async () => {
  const { seen, verifyOtp } = spy({ data: { user: USER }, error: null });
  const result = await verifyMagicLink(verifyOtp, { token_hash: "t" });
  assert.deepEqual(result, { ok: true, user: USER });
  assert.equal(seen.length, 1);
});
