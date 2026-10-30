// Drives `sendSignInLink` with DNS, headers, the budget, env and Supabase all
// swapped at module resolution (`registerHooks`, as `scripts/check-sign-in-budget.ts`
// does): nothing here touches the network, mints an `auth.users` row or sends
// mail. `mock.module` did not bite here: the action reaches Supabase through
// `await import` of a symlinked workspace package, and the real client loaded.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, test } from "node:test";

const calls: string[] = [];
let mxAnswer: () => Promise<{ exchange: string; priority: number }[]>;
const CLAIMED_KEYS = ["signin:caller-key", "signin-to:recipient-key"];
type Claim = { status: "ok"; keys: string[] } | { status: "rateLimited" } | { status: "noKey" };
let claimAnswer: Claim;
let otpError: { status: number } | null;
const released: string[][] = [];
let releaseGate: Promise<void> = Promise.resolve();
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
  release: async (keys: string[]) => {
    calls.push("release");
    released.push(keys);
    await releaseGate;
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
  "@/lib/account/sign-in-budget": `export const claimSignInLink = (...a) => ${D}.claim(...a);
    export const releaseSignInLink = (...a) => ${D}.release(...a);`,
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
  claimAnswer = { status: "ok", keys: CLAIMED_KEYS };
  released.length = 0;
  releaseGate = Promise.resolve();
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
  claimAnswer = { status: "rateLimited" };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "capped" });
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
  claimAnswer = { status: "rateLimited" };
  listAnswer = async () => false;
  const result = await (await getAction()).sendSignInLink("stranger@live.test");
  assert.deepEqual(result, { ok: false, error: "capped" });
  assert.ok(!calls.includes("list"));
});

// Auth-accepted sends only: a send Auth refused or never took gives the allowance back.
test("Auth answering 429 releases exactly the claimed keys and the result stays rateLimited", async () => {
  otpError = { status: 429 };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "rateLimited" });
  assert.deepEqual(released, [CLAIMED_KEYS]);
});

test("Auth answering 500 releases the claimed keys and the result stays sendFailed", async () => {
  otpError = { status: 500 };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "sendFailed" });
  assert.deepEqual(released, [CLAIMED_KEYS]);
});

test("RL-67: a timeout from Auth keeps the allowance and says the mail may have left", async () => {
  otpError = new AuthRetryableFetchError("fetch failed", 0) as unknown as { status: number };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "maybeSent" });
  assert.deepEqual(released, []);
});

test("an address off the list keeps the allowance spent", async () => {
  listAnswer = async () => false;
  const result = await (await getAction()).sendSignInLink("stranger@live.test");
  assert.deepEqual(result, { ok: false, error: "notInvited" });
  assert.deepEqual(released, []);
});

test("a list that cannot be read keeps the allowance spent", async () => {
  listAnswer = async () => {
    throw new Error("connection refused");
  };
  await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(released, []);
});

test("a send Auth accepted keeps the allowance spent", async () => {
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(released, []);
});

test("no claim, no release: a refused claim has nothing to give back", async () => {
  claimAnswer = { status: "rateLimited" };
  await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(released, []);
});

test("noKey claim: Auth failing releases nothing (there are no keys) and the send still ran", async () => {
  claimAnswer = { status: "noKey" };
  otpError = { status: 500 };
  const result = await (await getAction()).sendSignInLink("reader@live.test");
  assert.deepEqual(result, { ok: false, error: "sendFailed" });
  assert.ok(calls.includes("signInWithOtp"));
  assert.deepEqual(released.filter((k) => k.length > 0), []);
});

test("the release is awaited: the result waits for a release that has not finished", async () => {
  otpError = { status: 500 };
  let open!: () => void;
  releaseGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let settled = false;
  const pending = (await getAction()).sendSignInLink("reader@live.test").then((r) => {
    settled = true;
    return r;
  });
  for (let i = 0; i < 20 && !calls.includes("release"); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(calls.includes("release"), "the release never started");
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "the action answered before the release finished");
  open();
  assert.deepEqual(await pending, { ok: false, error: "sendFailed" });
});
