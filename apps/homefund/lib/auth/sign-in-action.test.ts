import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

// RF-143 / RF-01. The real `signInAction` runs; headers, cookies, Auth, the allowlist, DNS and
// the claim queries are doubled at module resolution. Every figure below is a real invocation
// of a double. Contract: a send Auth refused returns the claims it took; a send that may have
// left (timeout) or did leave keeps them.

type Claimed = { day: string; keys: string[] };
type Claim = { status: "ok"; claimed: Claimed } | { status: "rateLimited" } | { status: "noKey" };

const CLAIMED: Claimed = { day: "2026-10-17", keys: ["caller-key", "address-key"] };
const released: Claimed[] = [];
const otpCalls: unknown[] = [];
let claimAnswer: Claim;
let otpAnswer: { error: unknown };
let gate: Promise<void> | null = null;

const double = {
  claim: async () => claimAnswer,
  release: async (claimed: Claimed) => {
    released.push(claimed);
    if (gate) await gate;
  },
  createClient: async () => ({
    auth: {
      signInWithOtp: async (params: unknown) => {
        otpCalls.push(params);
        return otpAnswer;
      },
    },
  }),
};
(globalThis as unknown as { __signInDouble: typeof double }).__signInDouble = double;
const D = "globalThis.__signInDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "next/headers": `export const cookies = async () => ({ set: () => undefined, get: () => undefined, delete: () => undefined }); export const headers = async () => new Headers();`,
  "next/navigation": `export const redirect = () => {};`,
  "next-intl/server": `export const getLocale = async () => "en";`,
  "@/i18n/navigation": `export const redirect = () => {};`,
  "@/db/queries/allowlist": `export const isEmailAllowed = async () => true;`,
  "@/db/queries/sign-in-claims": `export const claimSignInLink = (...a) => ${D}.claim(...a); export const releaseSignInLink = (...a) => ${D}.release(...a);`,
  "@/lib/auth/land-session": `export const landSession = async () => ({ target: "/en", locale: "en" });`,
  "@/lib/auth/deliverability": `export const deliverabilityExempt = () => true; export const isDomainDeliverable = async () => true;`,
  "@/lib/env": `export const env = { NEXT_PUBLIC_SUPABASE_URL: "http://stub.invalid", NEXT_PUBLIC_SITE_URL: "http://site.invalid" };`,
  "@/lib/safe-action": `import { createSafeActionClient } from "next-safe-action";
    export const actionClient = createSafeActionClient({ defaultValidationErrorsShape: "flattened", handleServerError: (e) => e.messageKey ?? "errors.unexpected" });
    export const authActionClient = actionClient;`,
  "@/lib/supabase/server": `export const createSupabaseServerClient = (...a) => ${D}.createClient(...a);`,
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

const EMAIL = "persona@example.com";

async function send() {
  const { signInAction } = await import("../../app/actions/auth");
  return signInAction(undefined, { email: EMAIL });
}

beforeEach(() => {
  released.length = 0;
  otpCalls.length = 0;
  claimAnswer = { status: "ok", claimed: CLAIMED };
  otpAnswer = { error: null };
  gate = null;
});

// Mutation: remove the release call.
test("Auth's rate limit returns the claims it took and tells the person so", async () => {
  otpAnswer = { error: new AuthApiError("rate", 429, "over_email_send_rate_limit") };
  const result = await send();
  assert.equal(result?.serverError, "errors.emailRateLimited");
  assert.deepEqual(released, [CLAIMED], "released once, with exactly the keys claimed");
});

// Mutation: remove the release call.
test("a bare 429 status is the rate limit too, and releases", async () => {
  otpAnswer = { error: { status: 429 } };
  const result = await send();
  assert.equal(result?.serverError, "errors.emailRateLimited");
  assert.deepEqual(released, [CLAIMED]);
});

// Mutation: release only on 429.
test("an unexpected Auth error also returns the claims", async () => {
  otpAnswer = { error: { status: 500 } };
  const result = await send();
  assert.equal(result?.serverError, "errors.unexpected");
  assert.deepEqual(released, [CLAIMED]);
});

// Mutation: release on every error.
test("a timeout keeps the claim: the mail may have left", async () => {
  otpAnswer = { error: new AuthRetryableFetchError("fetch failed", 0) };
  const result = await send();
  assert.equal(result?.serverError, "errors.unexpected");
  assert.equal(released.length, 0);
});

// Mutation: release in a finally.
test("a send Auth accepted keeps the claim", async () => {
  const result = await send();
  assert.deepEqual(result?.data, { sent: true });
  assert.equal(otpCalls.length, 1);
  assert.equal(released.length, 0);
});

// Mutation: release on noKey.
test("noKey releases nothing, on a refusal or a success", async () => {
  claimAnswer = { status: "noKey" };
  otpAnswer = { error: { status: 500 } };
  assert.equal((await send())?.serverError, "errors.unexpected");
  otpAnswer = { error: new AuthApiError("rate", 429, "over_email_send_rate_limit") };
  assert.equal((await send())?.serverError, "errors.emailRateLimited");
  otpAnswer = { error: null };
  assert.deepEqual((await send())?.data, { sent: true });
  assert.equal(released.length, 0);
});

// Mutation: ask Auth before the cap, or release a claim that was never taken.
test("a capped send never reaches Auth and releases nothing", async () => {
  claimAnswer = { status: "rateLimited" };
  const result = await send();
  assert.equal(result?.serverError, "errors.signInLinkCapped");
  assert.equal(otpCalls.length, 0);
  assert.equal(released.length, 0);
});

// Mutation: drop the `await` before releaseSignInLink (the action answers before the claim is back).
test("the action does not answer until the release has finished", async () => {
  let open!: () => void;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  otpAnswer = { error: { status: 500 } };
  let settled = false;
  const pending = send().then((r) => {
    settled = true;
    return r;
  });
  while (released.length === 0) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "still pending while the release is");
  open();
  const result = await pending;
  assert.equal(settled, true);
  assert.equal(result?.serverError, "errors.unexpected");
});
