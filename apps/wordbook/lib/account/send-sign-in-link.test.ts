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
let listAnswer: () => Promise<boolean>;
const listAsked: string[] = [];

const notFound = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

const double = {
  resolveMx: (domain: string) => {
    calls.push(`mx:${domain}`);
    return mxAnswer();
  },
  resolveNone: notFound,
  allowed: (email: string) => {
    calls.push("list");
    listAsked.push(email);
    return listAnswer();
  },
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

async function getAction() {
  return import("../../app/actions/account");
}

beforeEach(() => {
  calls.length = 0;
  mxAnswer = async () => [{ exchange: "mx.live.test", priority: 10 }];
  claimAnswer = "ok";
  otpError = null;
  listAnswer = async () => true;
  listAsked.length = 0;
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

test("a listed deliverable address claims the budget, is checked against the list, then reaches Supabase, in that order", async () => {
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["mx:live.test", "claim", "list", "signInWithOtp"]);
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

test("an address off the list is refused as notInvited after the budget claim and before Supabase", async () => {
  listAnswer = async () => false;
  const result = await (await getAction()).sendSignInLink("stranger@live.test");
  assert.deepEqual(result, { ok: false, error: "notInvited" });
  assert.deepEqual(calls, ["mx:live.test", "claim", "list"], "the refusal came out of order or reached Supabase");
});

test("the list is asked about the address the reader typed", async () => {
  await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(listAsked, ["reader@live.test"]);
});

test("a list that cannot be read answers sendFailed and sends nothing", async () => {
  listAnswer = async () => {
    throw new Error("connection refused");
  };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "sendFailed" });
  assert.ok(!calls.includes("signInWithOtp"), "a failed list read still sent the link");
});

test("a dead domain is refused before the list is read", async () => {
  listAnswer = async () => false;
  mxAnswer = async () => [{ exchange: ".", priority: 0 }];
  const result = await (await getAction()).sendSignInLink("stranger@dead.test");
  assert.deepEqual(result, { ok: false, error: "domainUndeliverable" });
  assert.ok(!calls.includes("list"));
});

test("a caller over their allowance is refused before the list is read", async () => {
  claimAnswer = "rateLimited";
  listAnswer = async () => false;
  const result = await (await getAction()).sendSignInLink("stranger@live.test");
  assert.deepEqual(result, { ok: false, error: "rateLimited" });
  assert.ok(!calls.includes("list"));
});
