import assert from "node:assert/strict";
import Module from "node:module";
import test, { before, beforeEach, mock } from "node:test";

// Nothing here reaches Supabase or DNS: the auth client, the env and the
// deliverability probe are all simulated, so no test sends mail or mints an
// `auth.users` row (RNP-09).
const SITE = "https://pulsar.test";
let deliverable = true;
let answer: { error: { status?: number } | null } = { error: null };
const otpCalls: { email: string; options: { shouldCreateUser: boolean; emailRedirectTo: string } }[] = [];
const probed: string[] = [];

// The seam is `@supabase/ssr` and `next/headers`, under the real `@repo/supabase-auth`: the act
// loads that package with a dynamic import, which `mock.module` does not intercept (the real
// client would run). `Module._load` answers the three requests below, outermost, so no real
// client is ever built and nothing is dialled. `@/lib/env` is the real module over the fake
// values set here.
Object.assign(process.env, {
  DATABASE_URL: "postgres://nobody@localhost:1/none",
  NEXT_PUBLIC_SITE_URL: SITE,
  NEXT_PUBLIC_SUPABASE_URL: "https://s.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
});
const fakes: Record<string, unknown> = {
  "server-only": {},
  "next/headers": { cookies: async () => ({ getAll: () => [], set() {} }) },
  "@supabase/ssr": {
    createServerClient: () => ({
      auth: {
        signInWithOtp: async (call: (typeof otpCalls)[number]) => {
          otpCalls.push(call);
          return answer;
        },
      },
    }),
  },
};

mock.module("@/lib/auth/deliverability", {
  namedExports: {
    isDomainDeliverable: async (domain: string) => {
      probed.push(domain);
      return deliverable;
    },
  },
});

const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const innerLoad = untyped._load;
untyped._load = (request, parent, isMain) =>
  request in fakes ? fakes[request] : innerLoad(request, parent, isMain);

let sendSignInLink: typeof import("./account").sendSignInLink;

before(async () => {
  ({ sendSignInLink } = await import("./account"));
  // The act logs the provider's error on a failed send; the tests below read the result instead.
  mock.method(console, "error", () => {});
});

beforeEach(() => {
  deliverable = true;
  answer = { error: null };
  otpCalls.length = 0;
  probed.length = 0;
});

test("a valid address on a deliverable domain asks Auth once, for a link back to /auth/confirm", async () => {
  const result = await sendSignInLink("ana@correo.test");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(probed, ["correo.test"]);
  assert.equal(otpCalls.length, 1);
  assert.deepEqual(otpCalls[0], {
    email: "ana@correo.test",
    options: { shouldCreateUser: true, emailRedirectTo: `${SITE}/auth/confirm` },
  });
});

test("only the consent screen's path rides in the link as next", async () => {
  await sendSignInLink("ana@correo.test", "/oauth/autorizar?x=1");
  const url = new URL(otpCalls[0].options.emailRedirectTo);
  assert.equal(url.pathname, "/auth/confirm");
  assert.equal(url.searchParams.get("next"), "/oauth/autorizar?x=1");

  otpCalls.length = 0;
  await sendSignInLink("ana@correo.test", "https://mal");
  assert.equal(new URL(otpCalls[0].options.emailRedirectTo).searchParams.has("next"), false);
  assert.equal(otpCalls[0].options.emailRedirectTo, `${SITE}/auth/confirm`);
});

test("a domain that cannot take mail is refused before Auth is asked", async () => {
  deliverable = false;
  assert.deepEqual(await sendSignInLink("ana@muerto.test"), { ok: false, error: "domainUndeliverable" });
  assert.equal(otpCalls.length, 0);
});

test("a 429 reads rateLimited and any other failure sendFailed", async () => {
  answer = { error: { status: 429 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "rateLimited" });
  answer = { error: { status: 500 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "sendFailed" });
});

test("an address that is not one is refused with no probe and no call", async () => {
  assert.deepEqual(await sendSignInLink("x"), { ok: false, error: "emailInvalid" });
  assert.equal(probed.length, 0);
  assert.equal(otpCalls.length, 0);
});
