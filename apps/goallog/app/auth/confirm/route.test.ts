import assert from "node:assert/strict";
import Module from "node:module";
import test, { before, beforeEach, mock } from "node:test";

import { createServerClient } from "@supabase/ssr";
import { NextRequest } from "next/server";

import { SIGNED_IN_MARKER } from "@/lib/auth/signed-in-marker";

// RP-131 and RP-18: `/auth/confirm` lands a `code` link only in the browser that holds its verifier, and
// still lands a `token_hash` link. The real `@repo/supabase-auth` and `@supabase/ssr` run; Supabase itself
// is a fake `fetch`, so every request the route makes to Auth is counted and nothing leaves the process.
const SITE = "https://pulsar.test";
const SUPABASE = "https://s.test";
Object.assign(process.env, {
  DATABASE_URL: "postgres://nobody@localhost:1/none",
  NEXT_PUBLIC_SITE_URL: SITE,
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
});

// The browser's cookies: what the request carries and what `next/headers` reads and writes.
const jar = new Map<string, string>();
type AuthCall = { path: string; body: Record<string, unknown> };
const authCalls: AuthCall[] = [];
let tokenAnswer: "session" | "refused" | "timeout" = "session";

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
  if (url.pathname === "/auth/v1/verify") return json(200, session());
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

test("a code opened in the browser that asked exchanges once, signs in and lands on /", async () => {
  await askForLink();
  const response = await land("code=c-123");
  assert.equal(target(response), "/");
  assert.equal(authCalls.length, 1);
  assert.equal(exchanges().length, 1);
  assert.equal(exchanges()[0].body.auth_code, "c-123");
  assert.ok(exchanges()[0].body.code_verifier, "the exchange carries the browser's verifier");
  assert.ok(
    [...jar.keys()].some((name) => /^sb-s-auth-token(\.\d+)?$/.test(name)),
    "the session cookie is written",
  );
});

test("a code with the consent as next lands back on the consent", async () => {
  await askForLink();
  const next = "/oauth/autorizar?client_id=a";
  const response = await land(`code=c-123&next=${encodeURIComponent(next)}`);
  assert.equal(target(response), next);
  assert.equal(exchanges().length, 1);
});

test("a code with a foreign next lands on /", async () => {
  await askForLink();
  const response = await land(`code=c-123&next=${encodeURIComponent("https://evil.example/oauth/autorizar")}`);
  assert.equal(target(response), "/");
});

test("a code opened in a browser with no verifier is linkOtherBrowser and Auth is never asked", async () => {
  const response = await land("code=c-123");
  assert.equal(target(response), "/entrar?error=linkOtherBrowser");
  assert.equal(authCalls.length, 0);
});

test("a code opened in a browser signed in already but holding no verifier is still linkOtherBrowser", async () => {
  jar.set("sb-s-auth-token", `base64-${Buffer.from(JSON.stringify(session())).toString("base64url")}`);
  const response = await land("code=c-123");
  assert.equal(target(response), "/entrar?error=linkOtherBrowser");
  assert.equal(authCalls.length, 0);
});

test("a code Auth refuses is linkInvalid, asked once", async () => {
  await askForLink();
  tokenAnswer = "refused";
  const response = await land("code=c-123");
  assert.equal(target(response), "/entrar?error=linkInvalid");
  assert.equal(exchanges().length, 1);
  assert.equal(authCalls.length, 1);
});

test("a code whose exchange times out is linkTimeout, never retried", async () => {
  await askForLink();
  tokenAnswer = "timeout";
  const response = await land("code=c-123");
  assert.equal(target(response), "/entrar?error=linkTimeout");
  assert.equal(exchanges().length, 1);
  assert.equal(authCalls.length, 1);
});

test("a token_hash link still verifies once and lands on /", async () => {
  const response = await land("token_hash=h-1&type=magiclink");
  assert.equal(target(response), "/");
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].path, "/auth/v1/verify");
  assert.equal(authCalls[0].body.token_hash, "h-1");
});

test("a link with neither a code nor a token_hash is linkInvalid and Auth is never asked", async () => {
  const response = await land("type=magiclink");
  assert.equal(target(response), "/entrar?error=linkInvalid");
  assert.equal(authCalls.length, 0);
});

// RP-136: a landed link leaves a readable marker so the code step can tell its pending code is spent.
const marker = (response: Response) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${SIGNED_IN_MARKER}=`));

test("a landed link leaves the signed-in marker, readable by script, for an hour", async () => {
  await askForLink();
  const line = marker(await land("code=c-123"));
  assert.ok(line, "the marker is set");
  assert.match(line, new RegExp(`^${SIGNED_IN_MARKER}=\\d+;`));
  assert.match(line, /Path=\//i);
  assert.match(line, /Max-Age=3600/i);
  assert.match(line, /SameSite=lax/i);
  assert.doesNotMatch(line, /HttpOnly/i);
});

test("a landed token_hash link leaves the marker too", async () => {
  assert.ok(marker(await land("token_hash=h-1&type=magiclink")));
});

test("a landing on the consent leaves the marker and keeps its target", async () => {
  await askForLink();
  const next = "/oauth/autorizar?client_id=a";
  const response = await land(`code=c-123&next=${encodeURIComponent(next)}`);
  assert.equal(target(response), next);
  assert.ok(marker(response));
});

test("a refused link leaves no marker", async () => {
  await askForLink();
  tokenAnswer = "refused";
  assert.equal(marker(await land("code=c-123")), undefined);
});

test("a timed-out link leaves no marker", async () => {
  await askForLink();
  tokenAnswer = "timeout";
  assert.equal(marker(await land("code=c-123")), undefined);
});

test("a link opened in another browser leaves no marker", async () => {
  assert.equal(marker(await land("code=c-123")), undefined);
});
