// RL-73: `verifySignInCode` turns an address and a six-digit code into a session.
// Drives the real action with headers, cookies, env, DNS, the cap, the list and
// Supabase swapped at module resolution (`registerHooks`, as
// `send-sign-in-link.test.ts` does): nothing here reaches the network, mints an
// `auth.users` row or sends mail. Every double counts its real invocations.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

type Params = { email: string; token: string; type: string };

const calls: string[] = [];
const verifyCalls: Params[] = [];
let verifyAnswer: () => { data: { user: { id: string } | null; session: unknown }; error: unknown };

const USER = { id: "00000000-0000-4000-8000-000000000073" };

const double = {
  resolve: () => {
    calls.push("dns");
    return Promise.resolve([{ exchange: "mx.live.test", priority: 10 }]);
  },
  claim: async () => {
    calls.push("claim");
    return "ok";
  },
  allowed: async () => {
    calls.push("list");
    return true;
  },
  redirect: () => {
    calls.push("redirect");
  },
  createClient: () => {
    calls.push("client");
    return {
      auth: {
        verifyOtp: async (params: Params) => {
          verifyCalls.push(params);
          return verifyAnswer();
        },
        signInWithOtp: async () => {
          calls.push("signInWithOtp");
          return { error: null };
        },
      },
    };
  },
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => undefined, delete: () => undefined }),
};
(globalThis as unknown as { __verifyDouble: typeof double }).__verifyDouble = double;
const D = "globalThis.__verifyDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "node:dns/promises": `export const resolveMx = () => ${D}.resolve();
    export const resolve4 = () => ${D}.resolve();
    export const resolve6 = () => ${D}.resolve();`,
  "next/navigation": `export const redirect = (...a) => ${D}.redirect(...a);`,
  "next/headers": `export const headers = () => ${D}.headers(); export const cookies = () => ${D}.cookies();`,
  "@/lib/auth/allowlist": `export const isEmailAllowed = (...a) => ${D}.allowed(...a);`,
  "@/lib/account/sign-in-budget": `export const claimSignInLink = (...a) => ${D}.claim(...a);`,
  "@/lib/env": `export const env = { NEXT_PUBLIC_SUPABASE_URL: "http://stub.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "stub", NEXT_PUBLIC_SITE_URL: "http://site.invalid" };`,
  "@repo/supabase-auth": `export const createSupabaseServerClient = (...a) => ${D}.createClient(...a);`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) {
      return { format: "module", source: DOUBLES[url.slice("double:".length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

async function action() {
  return (await import("../../app/actions/account")).verifySignInCode;
}

async function schema() {
  return (await import("./sign-in-code")).signInCodeSchema;
}

const EMAIL = "lectora@live.test";

beforeEach(() => {
  calls.length = 0;
  verifyCalls.length = 0;
  verifyAnswer = () => ({ data: { user: USER, session: { access_token: "t" } }, error: null });
});

// --- The schema the form and the action share ---

// Mutation: regex `^\d{5,6}$`, `^\d{6,7}$`, `^\w{6}$`, or `\d{6}` unanchored.
test("the code schema refuses anything but exactly six digits", async () => {
  const signInCodeSchema = await schema();
  for (const code of ["12345", "1234567", "abcdef", "12a456", "123 456", "", "1234567890"]) {
    assert.equal(signInCodeSchema.safeParse(code).success, false, `${JSON.stringify(code)} was taken as a code`);
  }
});

// Mutation: drop `.trim()` (a pasted code with a trailing space is refused), or a transform that pads or cuts.
test("the code schema takes six digits, spaces around them trimmed off, leading zeros kept", async () => {
  const signInCodeSchema = await schema();
  assert.equal(signInCodeSchema.parse("123456"), "123456");
  assert.equal(signInCodeSchema.parse(" 123456 "), "123456");
  assert.equal(signInCodeSchema.parse("000731"), "000731");
});

// --- The action ---

// Mutation: regex `^\d{5,6}$` in the schema, or the action asking Auth before the shape check.
test("a code that is not six digits answers codeShape and Auth is never asked", async () => {
  const verifySignInCode = await action();
  for (const code of ["12345", "abcdef", "1234567"]) {
    const result = await verifySignInCode(EMAIL, code);
    assert.deepEqual(result, { ok: false, error: "codeShape" }, `on ${JSON.stringify(code)}`);
  }
  assert.equal(verifyCalls.length, 0, "Auth was asked about a code of the wrong shape");
});

// Mutation: skip the address check, so a malformed address reaches Auth.
test("a malformed address answers emailInvalid and Auth is never asked", async () => {
  const verifySignInCode = await action();
  const result = await verifySignInCode("not-an-address", "123456");
  assert.deepEqual(result, { ok: false, error: "emailInvalid" });
  assert.equal(verifyCalls.length, 0);
});

// Mutation: a retry, `type: "magiclink"`, or `token_hash` for `token`.
test("a good code asks Auth exactly once, as an email code for that address, and answers ok", async () => {
  const verifySignInCode = await action();
  const result = await verifySignInCode(EMAIL, "123456");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(verifyCalls, [{ email: EMAIL, token: "123456", type: "email" }]);
});

// Mutation: pass the raw input to Auth instead of the schema's output.
test("the code Auth is asked about is the trimmed one", async () => {
  const verifySignInCode = await action();
  await verifySignInCode(EMAIL, " 123456 ");
  assert.deepEqual(verifyCalls, [{ email: EMAIL, token: "123456", type: "email" }]);
});

// Mutation: run the DNS guard, the cap or the list before verifying, or redirect after it.
test("verifying sends nothing: no DNS lookup, no cap claim, no list read, no send, no redirect", async () => {
  const verifySignInCode = await action();
  await verifySignInCode(EMAIL, "123456");
  verifyAnswer = () => ({ data: { user: null, session: null }, error: new AuthApiError("expired", 403, "otp_expired") });
  await verifySignInCode(EMAIL, "123456");
  const stray = calls.filter((call) => call !== "client");
  assert.deepEqual(stray, [], `verifying reached ${stray.join(", ")}`);
});

// Mutation: collapse every failure to codeInvalid, or swap two of the reasons.
test("each refusal from Auth answers its own reason, and Auth is asked once each time", async () => {
  const verifySignInCode = await action();
  const cases: [unknown, string][] = [
    [new AuthApiError("Token has expired or is invalid", 403, "otp_expired"), "codeInvalid"],
    [new AuthRetryableFetchError("Gateway Timeout", 504), "codeTimeout"],
    [new AuthApiError("Too many requests", 429, "over_request_rate_limit"), "rateLimited"],
  ];
  for (const [error, reason] of cases) {
    verifyCalls.length = 0;
    verifyAnswer = () => ({ data: { user: null, session: null }, error });
    const result = await verifySignInCode(EMAIL, "123456");
    assert.deepEqual(result, { ok: false, error: reason }, `on ${String(error)}`);
    assert.equal(verifyCalls.length, 1, `asked ${verifyCalls.length} times on ${String(error)}`);
  }
});

// Mutation: the action tests only `error`, so an answer with no user passes as ok.
test("an answer with no user is a refusal, not a session", async () => {
  const verifySignInCode = await action();
  verifyAnswer = () => ({ data: { user: null, session: null }, error: null });
  const result = await verifySignInCode(EMAIL, "123456");
  assert.equal(result.ok, false);
});
