import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import { AuthApiError } from "@supabase/supabase-js";

// RF-146. The real `verifyCodeAction` runs; headers, cookies, Auth, the database and the
// redirect are doubled at module resolution (`registerHooks`). Every figure below is a real
// invocation of a double, never a reading of the action's text.

type Params = { email: string; token: string; type: string };
type Cookie = { name: string; value: string; options: Record<string, unknown> };

const USER = { id: "00000000-0000-4000-8000-000000000146", email: "persona@example.com" };
const verifyCalls: Params[] = [];
const cookiesSet: Cookie[] = [];
const redirects: string[] = [];
const landed: { locale: string }[] = [];
let answer: () => { data: { user: typeof USER | null }; error: unknown };
let landLocale = "en";

const double = {
  createClient: async () => ({
    auth: {
      verifyOtp: async (params: Params) => {
        verifyCalls.push(params);
        return answer();
      },
    },
  }),
  land: async ({ fallbackLocale }: { fallbackLocale: string }) => {
    landed.push({ locale: fallbackLocale });
    return { target: `/${landLocale}/bienvenida`, locale: landLocale };
  },
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => cookiesSet.push({ name, value, options }),
    get: () => undefined,
    delete: () => undefined,
  }),
  redirect: (to: string) => redirects.push(to),
};
(globalThis as unknown as { __codeActionDouble: typeof double }).__codeActionDouble = double;
const D = "globalThis.__codeActionDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "next/headers": `export const cookies = () => ${D}.cookies(); export const headers = async () => new Headers();`,
  "next/navigation": `export const redirect = (...a) => ${D}.redirect(...a);`,
  "next-intl/server": `export const getLocale = async () => "en";`,
  "@/i18n/navigation": `export const redirect = () => {};`,
  "@/db/queries/allowlist": `export const isEmailAllowed = async () => true;`,
  "@/db/queries/sign-in-claims": `export const claimSignInLink = async () => "ok";`,
  "@/lib/auth/land-session": `export const landSession = (...a) => ${D}.land(...a);`,
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

async function action() {
  return (await import("../../app/actions/auth")).verifyCodeAction;
}

beforeEach(() => {
  verifyCalls.length = 0;
  cookiesSet.length = 0;
  redirects.length = 0;
  landed.length = 0;
  landLocale = "en";
});

test("a refused code asks Auth once, whatever the refusal", async () => {
  const verifyCodeAction = await action();
  const refusals = [
    new AuthApiError("Token has expired or is invalid", 403, "otp_expired"),
    new AuthApiError("rate", 429, "over_request_rate_limit"),
    new Error("boom"),
  ];
  for (const error of refusals) {
    verifyCalls.length = 0;
    answer = () => ({ data: { user: null }, error });
    const result = await verifyCodeAction({ email: USER.email, code: "123456" });
    assert.ok(result?.serverError, "a refusal reaches the person");
    assert.equal(verifyCalls.length, 1);
  }
});

test("an accepted code asks Auth once and lands without a second verification", async () => {
  const verifyCodeAction = await action();
  answer = () => ({ data: { user: USER }, error: null });
  await verifyCodeAction({ email: USER.email, code: "123456" });
  assert.deepEqual(verifyCalls, [{ email: USER.email, token: "123456", type: "email" }]);
  assert.equal(landed.length, 1);
  assert.deepEqual(redirects, ["/en/bienvenida"]);
});

test("a landed code sets NEXT_LOCALE to the locale the person landed in, as the link does", async () => {
  const verifyCodeAction = await action();
  landLocale = "es";
  answer = () => ({ data: { user: USER }, error: null });
  await verifyCodeAction({ email: USER.email, code: "123456" });
  const cookie = cookiesSet.find((c) => c.name === "NEXT_LOCALE");
  assert.ok(cookie, "NEXT_LOCALE is set");
  assert.equal(cookie.value, "es");
  assert.equal(cookie.options.path, "/");
  assert.equal(cookie.options.maxAge, 60 * 60 * 24 * 365);
});

test("a refused code sets no cookie and lands nobody", async () => {
  const verifyCodeAction = await action();
  answer = () => ({ data: { user: null }, error: new AuthApiError("bad", 403, "otp_expired") });
  await verifyCodeAction({ email: USER.email, code: "123456" });
  assert.equal(cookiesSet.length, 0);
  assert.equal(landed.length, 0);
  assert.equal(redirects.length, 0);
});
