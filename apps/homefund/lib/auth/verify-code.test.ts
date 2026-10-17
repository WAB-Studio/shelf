import assert from "node:assert/strict";
import test from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import { signInCodeSchema, signInSchema } from "../validation/auth";
import { verifySignInCode } from "./verify-code";

// RF-146. `verifyOtp` is a spy: no test reaches Auth, and every count below is
// a real invocation, never a reading of the module's text.

type Params = { email: string; token: string; type: string };
type User = { id: string; email: string };

const EMAIL = "persona@example.com";
const USER: User = { id: "00000000-0000-4000-8000-000000000146", email: EMAIL };

function spy(answer: { data: { user: User | null }; error: unknown }) {
  const calls: Params[] = [];
  const verifyOtp = async (params: Params) => {
    calls.push(params);
    return answer;
  };
  return { calls, verifyOtp };
}

function codeIssues(input: unknown) {
  const parsed = signInCodeSchema.safeParse(input);
  assert.equal(parsed.success, false, `expected ${JSON.stringify(input)} to be refused`);
  return parsed.error!.issues.filter((issue) => issue.path.join(".") === "code").map((issue) => issue.message);
}

// Mutation: regex `^\d{5,6}$` (five digits pass), or `^\d{6,7}$` (seven pass), or `^\w{6}$` (a letter passes).
for (const code of ["12345", "1234567", "12a456", ""]) {
  test(`a code of ${JSON.stringify(code)} is refused with auth.errors.codeShape before Auth is asked`, () => {
    assert.deepEqual(codeIssues({ email: EMAIL, code }), ["auth.errors.codeShape"]);
  });
}

// Mutation: drop `.trim()` before the regex.
test("a six-digit code typed with spaces around it is taken as its six digits", () => {
  const parsed = signInCodeSchema.parse({ email: EMAIL, code: " 123456 " });
  assert.equal(parsed.code, "123456");
});

// Property: the address obeys the sign-in form's rule, whatever that rule does with case and padding.
// Mutation: a fresh `z.email()` without signInSchema's `.toLowerCase()` or its message.
test("the address is held to the sign-in form's own rule: same verdict, same value, same message", () => {
  const addresses = ["Persona@Example.COM", "persona@example.com", "  Persona@Example.COM ", "not-an-address", "", "a@b"];
  for (const email of addresses) {
    const link = signInSchema.safeParse({ email });
    const code = signInCodeSchema.safeParse({ email, code: "123456" });
    assert.equal(code.success, link.success, `verdict on ${JSON.stringify(email)}`);
    if (link.success && code.success) assert.equal(code.data.email, link.data.email);
    if (!link.success && !code.success) {
      const messages = (issues: { path: PropertyKey[]; message: string }[]) =>
        issues.filter((issue) => issue.path.join(".") === "email").map((issue) => issue.message);
      assert.deepEqual(messages(code.error.issues), messages(link.error.issues));
    }
  }
  assert.equal(signInCodeSchema.parse({ email: "Persona@Example.COM", code: "123456" }).email, EMAIL);
});

// Mutation: `type: "magiclink"`, `token_hash` for `token`, or the email left out.
test("a typed code asks Auth exactly once, as an email code for that address, and returns its user", async () => {
  const { calls, verifyOtp } = spy({ data: { user: USER }, error: null });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(calls, [{ email: EMAIL, token: "123456", type: "email" }]);
  assert.deepEqual(result, { ok: true, user: USER });
});

// Mutation: map every error to `codeTimeout`.
test("a wrong or expired code reads as codeInvalid", async () => {
  const { calls, verifyOtp } = spy({
    data: { user: null },
    error: new AuthApiError("Token has expired or is invalid", 403, "otp_expired"),
  });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
  assert.equal(calls.length, 1);
});

// Mutation: drop the retryable branch (it falls to codeInvalid), or call `verifyOtp` again on it.
test("Auth not answering reads as codeTimeout, and the code is not tried a second time", async () => {
  const { calls, verifyOtp } = spy({
    data: { user: null },
    error: new AuthRetryableFetchError("Gateway Timeout", 504),
  });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeTimeout" });
  assert.equal(calls.length, 1);
});

// Mutation: drop the 429 branch.
test("a 429 reads as codeRateLimited", async () => {
  const { calls, verifyOtp } = spy({ data: { user: null }, error: { status: 429 } });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeRateLimited" });
  assert.equal(calls.length, 1);
});

// Mutation: drop the `over_request_rate_limit` half of the rate-limit test.
test("over_request_rate_limit reads as codeRateLimited whatever the status", async () => {
  const { verifyOtp } = spy({
    data: { user: null },
    error: new AuthApiError("Request rate limit reached", 400, "over_request_rate_limit"),
  });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeRateLimited" });
});

// Mutation: test only `error`, so a missing user passes as ok.
test("an answer with no error and no user reads as codeInvalid", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: null });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
});

// Mutation: read a non-429 server error as codeRateLimited or codeTimeout (e.g. `status >= 400`).
test("any other refusal from Auth reads as codeInvalid", async () => {
  const { verifyOtp } = spy({ data: { user: null }, error: new AuthApiError("Database error", 500, "unexpected_failure") });
  const result = await verifySignInCode(verifyOtp, { email: EMAIL, code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "codeInvalid" });
});

// Property: whatever Auth answers, it is asked once per typed code (docs/TRAPS.md, never verify twice).
// Mutation: a retry loop on any failure.
test("whatever Auth answers, it is asked exactly once", async () => {
  const answers: unknown[] = [
    null,
    new AuthApiError("expired", 403, "otp_expired"),
    new AuthRetryableFetchError("Gateway Timeout", 504),
    new AuthRetryableFetchError("Service Unavailable", 503),
    { status: 429 },
    new AuthApiError("limit", 429, "over_request_rate_limit"),
    new AuthApiError("boom", 500, undefined),
    new Error("socket hang up"),
  ];
  for (const error of answers) {
    const { calls, verifyOtp } = spy({ data: { user: error === null ? USER : null }, error });
    await verifySignInCode(verifyOtp, { email: EMAIL, code: "654321" });
    assert.equal(calls.length, 1, `asked ${calls.length} times on ${String(error)}`);
    assert.deepEqual(calls[0], { email: EMAIL, token: "654321", type: "email" });
  }
});
