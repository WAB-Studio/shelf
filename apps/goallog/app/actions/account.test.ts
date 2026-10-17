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
// RP-131: the list stands in for `goals.allowed_emails`; every address below is on it unless a test says not.
let allowed = true;
const listChecked: string[] = [];
// RP-136: what `verifyOtp` answers and every call it received. One entry per real invocation.
type VerifyAnswer = { data: { user: { id: string } | null; session: unknown }; error: unknown };
const signedIn: VerifyAnswer = { data: { user: { id: "u1" }, session: { access_token: "t" } }, error: null };
let verifyAnswer: VerifyAnswer = signedIn;
const verifyCalls: unknown[] = [];

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
        verifyOtp: async (params: unknown) => {
          verifyCalls.push(params);
          return verifyAnswer;
        },
      },
    }),
  },
};

mock.module("@/lib/auth/allowlist", {
  namedExports: {
    isEmailAllowed: async (email: string) => {
      listChecked.push(email);
      return allowed;
    },
  },
});

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
let verifySignInCode: typeof import("./account").verifySignInCode;

before(async () => {
  ({ sendSignInLink, verifySignInCode } = await import("./account"));
  // The act logs the provider's error on a failed send; the tests below read the result instead.
  mock.method(console, "error", () => {});
});

beforeEach(() => {
  deliverable = true;
  answer = { error: null };
  otpCalls.length = 0;
  probed.length = 0;
  allowed = true;
  listChecked.length = 0;
  verifyAnswer = signedIn;
  verifyCalls.length = 0;
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

test("an address not on the list is refused as notInvited before DNS or Auth is asked", async () => {
  allowed = false;
  assert.deepEqual(await sendSignInLink("extrano@correo.test"), { ok: false, error: "notInvited" });
  assert.deepEqual(listChecked, ["extrano@correo.test"]);
  assert.equal(probed.length, 0);
  assert.equal(otpCalls.length, 0);
});

test("an address on the list is checked once, probed once and sent once", async () => {
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: true });
  assert.deepEqual(listChecked, ["ana@correo.test"]);
  assert.deepEqual(probed, ["correo.test"]);
  assert.equal(otpCalls.length, 1);
  assert.equal(otpCalls[0].options.shouldCreateUser, true);
});

test("an address on the list whose domain takes no mail is still refused as domainUndeliverable", async () => {
  deliverable = false;
  assert.deepEqual(await sendSignInLink("ana@muerto.test"), { ok: false, error: "domainUndeliverable" });
  assert.equal(listChecked.length, 1);
  assert.equal(otpCalls.length, 0);
});

test("a string that is no address never reaches the list", async () => {
  assert.deepEqual(await sendSignInLink("x"), { ok: false, error: "emailInvalid" });
  assert.equal(listChecked.length, 0);
});

test("the refusal and the two link screens read the words the user chose", async () => {
  const { default: messages } = await import("@/messages/es/account.json");
  const errors = messages.errors as Record<string, string>;
  assert.equal(errors.notInvited, "Este correo no tiene invitación a GoalLog.");
  assert.equal(errors.linkOtherBrowserTitle, "Abre el enlace en el navegador donde lo pediste");
  assert.equal(
    errors.linkOtherBrowserBody,
    "Por seguridad el enlace solo entra en el navegador que lo pidió. Pide uno nuevo aquí abajo si cambiaste.",
  );
});

// RP-136 · the six-digit code. `redirect` is the real one from `next/navigation`: it throws, and its
// digest carries the target, so a landing is read from what the action threw, never from a double.
async function landing(run: Promise<unknown>): Promise<string> {
  let returned: unknown;
  try {
    returned = await run;
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    assert.equal(typeof digest, "string", `threw something that is not a redirect: ${String(error)}`);
    const [kind, , target] = (digest as string).split(";");
    assert.equal(kind, "NEXT_REDIRECT");
    const url = new URL(target, SITE);
    assert.equal(url.origin, SITE, `left the site: ${target}`);
    return url.pathname + url.search;
  }
  assert.fail(`a verified code returned instead of landing: ${JSON.stringify(returned)}`);
}

test("RP-136 a code that is not six digits is codeShape, and Auth is never asked", async () => {
  for (const code of ["12345", "1234567", "12a456", "abcdef", ""]) {
    assert.deepEqual(await verifySignInCode("ana@correo.test", code), { ok: false, error: "codeShape" }, code);
  }
  assert.deepEqual(verifyCalls, []);
});

test("RP-136 an address that is not one is emailInvalid, and Auth is never asked", async () => {
  assert.deepEqual(await verifySignInCode("x", "123456"), { ok: false, error: "emailInvalid" });
  assert.deepEqual(verifyCalls, []);
});

test("RP-136 a code Auth could not answer is asked once, with the address, the code and type email", async () => {
  const { AuthRetryableFetchError } = await import("@supabase/supabase-js");
  verifyAnswer = { data: { user: null, session: null }, error: new AuthRetryableFetchError("Gateway Timeout", 504) };
  assert.deepEqual(await verifySignInCode("ana@correo.test", "123456"), { ok: false, error: "codeTimeout" });
  assert.deepEqual(verifyCalls, [{ email: "ana@correo.test", token: "123456", type: "email" }]);
});

test("RP-136 a verified code is asked once and sends nothing", async () => {
  await landing(verifySignInCode("ana@correo.test", "654321"));
  assert.deepEqual(verifyCalls, [{ email: "ana@correo.test", token: "654321", type: "email" }]);
  assert.equal(otpCalls.length, 0);
});

test("RP-136 a wrong or expired code is codeInvalid, a rate limit rateLimited, and each logs its detail", async () => {
  const { AuthApiError } = await import("@supabase/supabase-js");
  const logged = (console.error as unknown as { mock: { calls: { arguments: unknown[] }[]; resetCalls(): void } })
    .mock;

  logged.resetCalls();
  verifyAnswer = { data: { user: null, session: null }, error: new AuthApiError("Token has expired or is invalid", 403, "otp_expired") };
  assert.deepEqual(await verifySignInCode("ana@correo.test", "123456"), { ok: false, error: "codeInvalid" });
  assert.match(logged.calls.map((call) => call.arguments.map(String).join(" ")).join("\n"), /otp_expired/);

  logged.resetCalls();
  verifyAnswer = {
    data: { user: null, session: null },
    error: new AuthApiError("For security purposes, you can only request this after 30 seconds.", 429, "over_request_rate_limit"),
  };
  assert.deepEqual(await verifySignInCode("ana@correo.test", "123456"), { ok: false, error: "rateLimited" });
  assert.match(logged.calls.map((call) => call.arguments.map(String).join(" ")).join("\n"), /429/);
  assert.equal(verifyCalls.length, 2);
});

test("RP-136 an answer with no error and no user is codeInvalid, not a session", async () => {
  verifyAnswer = { data: { user: null, session: null }, error: null };
  assert.deepEqual(await verifySignInCode("ana@correo.test", "123456"), { ok: false, error: "codeInvalid" });
});

test("RP-136 a verified code with no next lands on /", async () => {
  assert.equal(await landing(verifySignInCode("ana@correo.test", "123456")), "/");
});

test("RP-136 a verified code typed on the consent returns to that consent, query and all", async () => {
  const consent = "/oauth/autorizar?response_type=code&client_id=abc&state=s1";
  assert.equal(await landing(verifySignInCode("ana@correo.test", "123456", consent)), consent);
});

test("RP-136 a next that is not the consent lands on /", async () => {
  for (const next of ["https://evil.test/x", "//evil.test/x", "/entrar", "/oauth/autorizar/../../x"]) {
    assert.equal(await landing(verifySignInCode("ana@correo.test", "123456", next)), "/", next);
  }
});
