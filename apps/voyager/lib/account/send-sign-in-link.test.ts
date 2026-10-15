// Drives `sendSignInLink` with DNS, headers, the budget, env and Supabase all
// swapped at module resolution (`registerHooks`, as `scripts/check-sign-in-budget.ts`
// does): nothing here touches the network, mints an `auth.users` row or sends
// mail. `mock.module` did not bite here: the action reaches Supabase through
// `await import` of a symlinked workspace package, and the real client loaded.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const calls: string[] = [];
let mxAnswer: () => Promise<{ exchange: string; priority: number }[]>;
let claimAnswer: "ok" | "rateLimited" | "noKey";
let otpError: { status: number } | null;

const notFound = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

const double = {
  resolveMx: (domain: string) => {
    calls.push(`mx:${domain}`);
    return mxAnswer();
  },
  resolveNone: notFound,
  claim: async () => {
    calls.push("claim");
    return claimAnswer;
  },
  createClient: () => ({
    auth: {
      signInWithOtp: async () => {
        calls.push("signInWithOtp");
        return { error: otpError };
      },
    },
  }),
  headers: async () => new Headers(),
};
(globalThis as unknown as { __sendDouble: typeof double }).__sendDouble = double;
const D = "globalThis.__sendDouble";

const DOUBLES: Record<string, string> = {
  "node:dns/promises": `export const resolveMx = (d) => ${D}.resolveMx(d);
    export const resolve4 = () => ${D}.resolveNone();
    export const resolve6 = () => ${D}.resolveNone();`,
  "next/navigation": "export const redirect = () => undefined;",
  "next/headers": `export const headers = () => ${D}.headers();`,
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

async function getAction() {
  return import("../../app/actions/account");
}

beforeEach(() => {
  calls.length = 0;
  mxAnswer = async () => [{ exchange: "mx.live.test", priority: 10 }];
  claimAnswer = "ok";
  otpError = null;
});

test("an address on a null-MX domain is refused before the budget or Supabase is touched", async () => {
  mxAnswer = async () => [{ exchange: ".", priority: 0 }];
  const result = await (await getAction()).sendSignInLink("reader@dead.test");
  assert.deepEqual(result, { ok: false, error: "domainUndeliverable" });
  assert.deepEqual(calls, ["mx:dead.test"], "a dead address spent an allowance or reached Supabase");
});

test("an address on a domain with no records at all is refused before Supabase", async () => {
  mxAnswer = notFound as typeof mxAnswer;
  const result = await (await getAction()).sendSignInLink("reader@nowhere.test");
  assert.deepEqual(result, { ok: false, error: "domainUndeliverable" });
  assert.deepEqual(calls, ["mx:nowhere.test"]);
});

test("the domain asked about is the one after the last @", async () => {
  await (await getAction()).sendSignInLink("reader@live.test");
  assert.equal(calls[0], "mx:live.test");
});

test("a deliverable address claims the budget, then reaches Supabase, in that order", async () => {
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["mx:live.test", "claim", "signInWithOtp"]);
});

test("a caller over their allowance never reaches Supabase", async () => {
  claimAnswer = "rateLimited";
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "rateLimited" });
  assert.deepEqual(calls, ["mx:live.test", "claim"], "a refused claim reached Supabase");
});

test("a malformed address is refused before any DNS lookup", async () => {
  const result = await (await getAction()).sendSignInLink("not-an-address");
  assert.deepEqual(result, { ok: false, error: "emailInvalid" });
  assert.deepEqual(calls, []);
});
