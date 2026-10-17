import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import { NextRequest } from "next/server";

import { SIGNED_IN_MARKER } from "./signed-in-marker";

// RF-146: a landed sign-in link leaves a marker cookie the code step reads. The real GET of
// `/auth/confirm` runs; Auth and the landing are doubled.

const USER = { id: "00000000-0000-4000-8000-000000000146", email: "persona@example.com" };
let verifyAnswer: { data: { user: typeof USER | null }; error: unknown };
const verifyCalls: unknown[] = [];

const double = {
  createClient: async () => ({
    auth: {
      verifyOtp: async (params: unknown) => {
        verifyCalls.push(params);
        return verifyAnswer;
      },
      exchangeCodeForSession: async () => verifyAnswer,
    },
  }),
};
(globalThis as unknown as { __markerDouble: typeof double }).__markerDouble = double;
const D = "globalThis.__markerDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/lib/auth/land-session": `export const landSession = async () => ({ target: "/en/bienvenida", locale: "en" });`,
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

async function land(query: string) {
  const { GET } = await import("../../app/auth/confirm/route");
  return GET(new NextRequest(`http://site.invalid/auth/confirm?${query}`));
}
function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

beforeEach(() => {
  verifyCalls.length = 0;
  verifyAnswer = { data: { user: USER }, error: null };
});

test("the marker's name is the one the code step reads", () => {
  assert.equal(SIGNED_IN_MARKER, "homefund-signed-in-at");
});

// Mutation: set it before the verify; drop the cookie.
test("a landed token_hash link sets the marker: epoch text, site-wide, an hour, readable by script", async () => {
  const before = Date.now();
  const response = await land("token_hash=abc&type=magiclink");
  const after = Date.now();
  assert.equal(verifyCalls.length, 1);
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location")!, /\/en\/bienvenida$/);

  const cookie = setCookies(response).find((c) => c.startsWith(`${SIGNED_IN_MARKER}=`));
  assert.ok(cookie, "the marker rides on the redirect");
  const [pair, ...attrs] = cookie.split(/;\s*/);
  const value = pair.slice(SIGNED_IN_MARKER.length + 1);
  assert.match(value, /^\d+$/);
  assert.ok(Number(value) >= before && Number(value) <= after, "the value is Date.now()");
  const lower = attrs.map((a) => a.toLowerCase());
  assert.ok(lower.includes("path=/"));
  assert.ok(lower.includes("max-age=3600"));
  assert.ok(lower.includes("samesite=lax"));
  assert.ok(!lower.includes("httponly"), "the code step's client reads it");
});

// Mutation: set it before the verify.
test("a refused link sets no marker", async () => {
  verifyAnswer = { data: { user: null }, error: new Error("expired") };
  const response = await land("token_hash=abc&type=magiclink");
  assert.equal(verifyCalls.length, 1);
  assert.ok(response.headers.get("location")!.includes("error=linkInvalid"));
  assert.ok(!setCookies(response).some((c) => c.startsWith(`${SIGNED_IN_MARKER}=`)));
});

// Mutation: set it before the verify.
test("a malformed link sets no marker", async () => {
  const response = await land("foo=bar");
  assert.equal(verifyCalls.length, 0);
  assert.ok(!setCookies(response).some((c) => c.startsWith(`${SIGNED_IN_MARKER}=`)));
});
