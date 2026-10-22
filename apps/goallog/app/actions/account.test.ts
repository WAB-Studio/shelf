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
// RP-141: every `signOut` the action sends; `signOutError` is what Auth answers. Like the real client, the
// fake drops this device's session on every call, error or not (auth-js `_signOut` removes it before it returns).
const signOutCalls: unknown[] = [];
let signOutError: unknown = null;
let deviceSession: "kept" | "dropped" = "kept";
// RP-138: the daily caps live in `sign-in-budget`, which the action loads with a dynamic import that no
// module mock reaches; its own `db` and `env` are what get simulated. Every statement it sends is recorded.
// `refuseAt` is the claim (0 the caller's, 1 the address's) the database refuses; `salt` unset is no key.
// A release settles on a later tick, or only when the test lets it when `holdRelease` is set.
type Statement = { kind: "claim" | "release"; keys: Buffer[]; day: string };
const statements: Statement[] = [];
let refuseAt: number | null = null;
let salt: string | undefined = "test-salt-0123456789abcdef";
let holdRelease = false;
let releaseGate: (() => void) | null = null;
let order: string[] = [];

function params(node: unknown): unknown[] {
  if (Buffer.isBuffer(node) || typeof node === "string" || typeof node === "number") return [node];
  if (Array.isArray(node)) return node.flatMap(params);
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return [];
  return chunks.flatMap((chunk) => ("value" in Object(chunk) && Array.isArray((chunk as { value: unknown }).value) ? [] : params(chunk)));
}
function textOf(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return "";
  return chunks.map((chunk) => (Array.isArray((chunk as { value?: unknown })?.value) ? (chunk as { value: string[] }).value.join("") : textOf(chunk))).join("");
}
const fakeDb = {
  execute: async (query: unknown) => {
    const text = textOf(query);
    const found = params(query);
    const keys = found.filter((value): value is Buffer => Buffer.isBuffer(value));
    const day = found.find((value): value is string => typeof value === "string") as string;
    if (text.includes("sign_in_release")) {
      order.push("release");
      statements.push({ kind: "release", keys, day });
      await new Promise<void>((resolve) => {
        if (holdRelease) releaseGate = resolve;
        else setTimeout(resolve, 5);
      });
      return [];
    }
    order.push("claim");
    const at = statements.filter((statement) => statement.kind === "claim").length;
    statements.push({ kind: "claim", keys, day });
    return [{ ok: refuseAt !== at }];
  },
};

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
  "next/headers": {
    cookies: async () => ({ getAll: () => [], set() {} }),
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  },
  "@supabase/ssr": {
    createServerClient: () => ({
      auth: {
        signInWithOtp: async (call: (typeof otpCalls)[number]) => {
          order.push("auth");
          otpCalls.push(call);
          return answer;
        },
        verifyOtp: async (params: unknown) => {
          verifyCalls.push(params);
          return verifyAnswer;
        },
        signOut: async (options: unknown) => {
          signOutCalls.push(options);
          deviceSession = "dropped";
          return { error: signOutError };
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

// The action reads the caller's headers with a dynamic import, which only `mock.module` intercepts.
mock.module("next/headers", {
  namedExports: {
    cookies: fakes["next/headers"] && (fakes["next/headers"] as { cookies: unknown }).cookies,
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  },
});

const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const innerLoad = untyped._load;
let budgetEnv: unknown;
untyped._load = (request, parent, isMain) => {
  if (request === "@/db/client") return { db: fakeDb };
  if (request === "@/lib/env") {
    // Only `sign-in-budget` requires it: the real values, with the salt the test chooses.
    const real = (innerLoad(request, parent, isMain) as { env: object }).env;
    budgetEnv ??= { env: Object.create(real, { CLIENT_KEY_SALT: { get: () => salt } }) };
    return budgetEnv;
  }
  return request in fakes ? fakes[request] : innerLoad(request, parent, isMain);
};

let sendSignInLink: typeof import("./account").sendSignInLink;
let verifySignInCode: typeof import("./account").verifySignInCode;
let signOutAction: typeof import("./account").signOutAction;

before(async () => {
  ({ sendSignInLink, verifySignInCode, signOutAction } = await import("./account"));
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
  signOutCalls.length = 0;
  signOutError = null;
  deviceSession = "kept";
  statements.length = 0;
  refuseAt = null;
  salt = "test-salt-0123456789abcdef";
  releaseGate = null;
  holdRelease = false;
  order = [];
});

// Lets every already-queued continuation run; a promise still pending after this is waiting on something.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test("a valid address on a deliverable domain asks Auth once, for a link back to /auth/confirm", async () => {
  const result = await sendSignInLink("ana@correo.test");
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(probed, ["correo.test"]);
  assert.equal(otpCalls.length, 1);
  assert.deepEqual(otpCalls[0], {
    email: "ana@correo.test",
    options: { shouldCreateUser: false, emailRedirectTo: `${SITE}/auth/confirm` },
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

test("a listed address Auth has no user for (it refuses a sign-up with 422) reads sendFailed, never ok", async () => {
  // Kills: a refusal from Auth swallowed as success, so the person waits for a mail that never comes.
  answer = { error: { status: 422 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "sendFailed" });
  assert.equal(otpCalls.length, 1);
  assert.equal(otpCalls[0].options.shouldCreateUser, false);
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
  assert.equal(otpCalls[0].options.shouldCreateUser, false);
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

// RP-138 · the daily caps on sign-in codes.
const claims = () => statements.filter((statement) => statement.kind === "claim");
const releases = () => statements.filter((statement) => statement.kind === "release");

test("RP-138 a caller past its cap answers capped, Auth is never asked and the address spends nothing", async () => {
  refuseAt = 0;
  assert.deepEqual(await sendSignInLink("Ana@correo.test"), { ok: false, error: "capped" });
  assert.equal(otpCalls.length, 0);
  assert.equal(claims().length, 1);
  assert.equal(releases().length, 0);
});

test("RP-138 an address past its cap answers capped and Auth is never asked", async () => {
  refuseAt = 1;
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "capped" });
  assert.equal(otpCalls.length, 0);
  assert.equal(claims().length, 2);
});

test("RP-138 an address off the list spends no claim", async () => {
  allowed = false;
  assert.deepEqual(await sendSignInLink("extrano@correo.test"), { ok: false, error: "notInvited" });
  assert.deepEqual(statements, []);
});

test("RP-138 a domain that takes no mail spends no claim", async () => {
  deliverable = false;
  assert.deepEqual(await sendSignInLink("ana@muerto.test"), { ok: false, error: "domainUndeliverable" });
  assert.deepEqual(statements, []);
});

test("RP-138 an address that is not one spends no claim", async () => {
  assert.deepEqual(await sendSignInLink("x"), { ok: false, error: "emailInvalid" });
  assert.deepEqual(statements, []);
});

test("RP-138 the claim is made before Auth is asked, and a sent link keeps it", async () => {
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: true });
  assert.deepEqual(order, ["claim", "claim", "auth"]);
});

test("RP-138 a send Auth refuses with a 500 gives back exactly the keys and day it claimed, and reads sendFailed", async () => {
  answer = { error: { status: 500 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "sendFailed" });
  assert.equal(releases().length, 1);
  assert.equal(releases()[0].keys.length, 2);
  assert.deepEqual(releases()[0].keys, claims().flatMap((claim) => claim.keys));
  assert.equal(releases()[0].day, claims()[0].day);
});

test("RP-138 a 429 gives the claim back and still reads rateLimited", async () => {
  answer = { error: { status: 429 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "rateLimited" });
  assert.equal(releases().length, 1);
});

test("RP-138 a timeout keeps the claim", async () => {
  const { AuthRetryableFetchError } = await import("@supabase/supabase-js");
  answer = { error: new AuthRetryableFetchError("Gateway Timeout", 504) as unknown as { status?: number } };
  const result = await sendSignInLink("ana@correo.test");
  assert.equal(result.ok, false);
  assert.equal(otpCalls.length, 1);
  assert.equal(claims().length, 2);
  assert.equal(releases().length, 0);
});

test("RP-138 the action does not answer until the release has settled", async () => {
  answer = { error: { status: 500 } };
  holdRelease = true;
  let answered = false;
  const run = sendSignInLink("ana@correo.test").then((result) => {
    answered = true;
    return result;
  });
  await settle();
  assert.equal(releases().length, 1);
  assert.equal(answered, false, "answered while the release was still pending");
  releaseGate?.();
  assert.deepEqual(await run, { ok: false, error: "sendFailed" });
});

test("RP-138 with no key the action stays open: Auth is asked, the link is sent, nothing is counted", async () => {
  salt = undefined;
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: true });
  assert.equal(otpCalls.length, 1);
  assert.deepEqual(statements, []);
});

test("RP-138 with no key a refused send has nothing to give back", async () => {
  salt = undefined;
  answer = { error: { status: 500 } };
  assert.deepEqual(await sendSignInLink("ana@correo.test"), { ok: false, error: "sendFailed" });
  assert.deepEqual(statements, []);
});

// RP-141 · sign out on this device only.
test("RP-141 signing out asks Auth once, for this device alone, and lands on /entrar", async () => {
  assert.equal(await landing(signOutAction()), "/entrar");
  assert.deepEqual(signOutCalls, [{ scope: "local" }]);
  assert.equal(deviceSession, "dropped");
});

test("RP-141 an Auth refusal still leaves this device signed out and lands on /entrar?salida=parcial", async () => {
  signOutError = new Error("auth down");
  assert.equal(await landing(signOutAction()), "/entrar?salida=parcial");
  assert.deepEqual(signOutCalls, [{ scope: "local" }]);
  assert.equal(deviceSession, "dropped");
});

test("RP-141 signing out touches no connected AI's key", async () => {
  await landing(signOutAction());
  assert.deepEqual(statements, []);
  assert.equal(otpCalls.length, 0);
});
