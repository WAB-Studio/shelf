import assert from "node:assert/strict";
import Module from "node:module";
import test, { before, beforeEach, mock } from "node:test";

import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";

// RL-22: every failed landing of `/auth/confirm` says `no-store`, whether or not Auth was asked, and says it
// once even when Auth's own directives ride the same redirect.
// The real `@repo/supabase-auth` and `@supabase/ssr` run; Supabase itself
// is a fake `fetch`, so every request the route makes to Auth is counted and nothing leaves the process.
const SITE = "https://wordbook.test";
const SUPABASE = "https://s.test";
Object.assign(process.env, {
  DATABASE_URL: "postgres://nobody@localhost:1/none",
  MIGRATION_DATABASE_URL: "postgres://nobody@localhost:1/none",
  NEXT_PUBLIC_SITE_URL: SITE,
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
});

// The browser's cookies: what the request carries and what `next/headers` reads and writes.
const jar = new Map<string, string>();
type AuthCall = { path: string; body: Record<string, unknown> };
const authCalls: AuthCall[] = [];
let tokenAnswer: "session" | "refused" | "timeout" = "session";
let verifyAnswer: "session" | "refused" = "session";

const fakes: Record<string, unknown> = {
  "server-only": {},
  "next/headers": {
    cookies: async () => ({
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      has: (name: string) => jar.has(name),
      set: (name: string, value: string, options?: { maxAge?: number }) => {
        if (value === "" || options?.maxAge === 0) jar.delete(name);
        else jar.set(name, value);
      },
      delete: (name: string) => jar.delete(name),
    }),
  },
};
const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const innerLoad = untyped._load;
untyped._load = (request, parent, isMain) =>
  request in fakes ? fakes[request] : innerLoad(request, parent, isMain);

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const user = {
  id: "0b9b3a52-6a8e-4f0e-9c58-5f4a5b6a8f10",
  aud: "authenticated",
  role: "authenticated",
  email: "ana@correo.test",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-10-15T00:00:00Z",
};
const session = () => ({
  access_token: `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: "authenticated" })}.sig`,
  refresh_token: "r1",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== SUPABASE) return realFetch(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  authCalls.push({ path: `${url.pathname}${url.search}`, body });
  if (url.pathname === "/auth/v1/otp") return json(200, {});
  if (url.pathname === "/auth/v1/verify") {
    if (verifyAnswer === "refused") {
      // Auth takes a moment, as it does over a network: the client settles its stored session meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json(403, { code: "otp_expired", error_code: "otp_expired", msg: "Email link is invalid or has expired" });
    }
    return json(200, session());
  }
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
    if (tokenAnswer === "timeout") return new Response("Gateway Timeout", { status: 504 });
    if (tokenAnswer === "refused") {
      return json(403, { code: "flow_state_not_found", error_code: "flow_state_not_found", msg: "invalid flow state" });
    }
    return json(200, session());
  }
  throw new Error(`unexpected Auth request ${url.pathname}`);
}) as typeof fetch;

let GET: typeof import("./route").GET;

before(async () => {
  ({ GET } = await import("./route"));
  // The route logs why a link failed; the tests read the redirect instead.
  mock.method(console, "error", () => {});
});

beforeEach(() => {
  jar.clear();
  authCalls.length = 0;
  tokenAnswer = "session";
  verifyAnswer = "session";
});

// Asks for a link the way `sendSignInLink` does, so the jar holds the verifier cookies `@supabase/ssr` writes.
async function askForLink() {
  const client = createServerClient(SUPABASE, "sb_publishable_test", {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value === "") jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithOtp({ email: "ana@correo.test" });
  assert.equal(error, null);
  assert.ok([...jar.keys()].some((name) => name.endsWith("-code-verifier")), "the ask left a verifier cookie");
  authCalls.length = 0;
}

function land(query: string) {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  return GET(new NextRequest(`${SITE}/auth/confirm?${query}`, { headers: cookie ? { cookie } : {} }));
}

const target = (response: Response) => {
  const location = response.headers.get("location");
  assert.ok(location, `a redirect, got ${response.status}`);
  const url = new URL(location, SITE);
  return `${url.pathname}${url.search}`;
};


const exchanges = () => authCalls.filter((call) => call.path === "/auth/v1/token?grant_type=pkce");

const noStoreOnce = (response: Response) => {
  const cacheControl = response.headers.get("cache-control") ?? "";
  const directives = cacheControl.split(/[\s,]+/).filter(Boolean);
  assert.ok(directives.includes("no-store"), `cache-control «${cacheControl}» says no-store`);
  assert.equal(directives.filter((directive) => directive === "no-store").length, 1, `«${cacheControl}» says it once`);
};

test("a malformed landing query is linkInvalid and says no-store", async () => {
  const response = await land("x=1");
  assert.equal(target(response), "/cuenta?error=linkInvalid");
  assert.equal(authCalls.length, 0);
  noStoreOnce(response);
});

test("a code opened in another browser is linkOtherBrowser, Auth is never asked, and it says no-store", async () => {
  const response = await land("code=c-123");
  assert.equal(target(response), "/cuenta?error=linkOtherBrowser");
  assert.equal(authCalls.length, 0);
  noStoreOnce(response);
});

test("a code Auth refuses is linkInvalid and says no-store once", async () => {
  await askForLink();
  tokenAnswer = "refused";
  const response = await land("code=c-123");
  assert.equal(target(response), "/cuenta?error=linkInvalid");
  noStoreOnce(response);
});

test("a code whose exchange times out is linkTimeout and says no-store once", async () => {
  await askForLink();
  tokenAnswer = "timeout";
  const response = await land("code=c-123");
  assert.equal(target(response), "/cuenta?error=linkTimeout");
  noStoreOnce(response);
});

test("a code opened in the browser that asked lands on /cuenta with no error", async () => {
  await askForLink();
  const response = await land("code=c-123");
  assert.equal(target(response), "/cuenta");
  assert.equal(exchanges().length, 1);
});

// A session cookie Auth cannot read is cleared while the link is being verified, so `setAll` hands the route
// Auth's own `Cache-Control` (which already says `no-store`) before the refused link fails.
async function landRefusedWithBrokenSession() {
  jar.set("sb-s-auth-token", `base64-${b64url({ stale: true })}`);
  verifyAnswer = "refused";
  const response = await land("token_hash=h-1&type=magiclink");
  assert.equal(target(response), "/cuenta?error=linkInvalid");
  assert.equal(jar.has("sb-s-auth-token"), false, "Auth cleared the broken session, so its headers rode the redirect");
  return response;
}

test("a refused link whose Auth headers already say no-store says it once", async () => {
  noStoreOnce(await landRefusedWithBrokenSession());
});

test("a refused link keeps Auth's other cache directives beside no-store", async () => {
  const cacheControl = (await landRefusedWithBrokenSession()).headers.get("cache-control") ?? "";
  const directives = cacheControl.split(/[\s,]+/).filter(Boolean);
  for (const directive of ["private", "no-cache", "must-revalidate", "max-age=0"]) {
    assert.ok(directives.includes(directive), `«${cacheControl}» keeps ${directive}`);
  }
});
