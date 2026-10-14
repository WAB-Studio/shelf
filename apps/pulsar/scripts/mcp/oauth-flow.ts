// Proves RP-60 over HTTP, RNP-14 and RNP-15: register, approve through the
// consent act, exchange, list, refresh, revoke, and the replay that revokes.
// Drives the lane's running server (`PULSAR_BASE_URL`, else :3200 + lane - 1)
// started as `route.ts`'s header says; its log is `PULSAR_SERVER_LOG`.
// `NEXT_PUBLIC_SITE_URL` must be the server's own, and under `next start` it is
// the one `next build` baked in, so build with it set. Against `next start` on
// :3200 + lane - 1, inside `scripts/supabase-local.sh exec`:
//   NEXT_PUBLIC_SITE_URL=http://localhost:<port> npx next build
//   NODE_OPTIONS='<fetch hook of route.ts>' npx next start -p <port> > <log> 2>&1
//   PULSAR_SERVER_LOG=<log> NEXT_PUBLIC_SITE_URL=http://localhost:<port> npm run check:mcp
// A missing log or another issuer fails one test that names the variable.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";

const lane = Number(process.env.HARNESS_LANE ?? "1");
const base = (process.env.PULSAR_BASE_URL ?? `http://localhost:${3200 + lane - 1}`).replace(/\/+$/, "");
const logPath = resolve(process.cwd(), process.env.PULSAR_SERVER_LOG ?? `private/dev${new URL(base).port}.log`);
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
const REDIRECT = "http://localhost:6274/oauth/callback";
// A /64 of the documentation prefix, new each run: this file's calls to the two
// limited routes never share a counter with another lane's or another file's.
const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
const asRun = { "x-forwarded-for": from };

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
(globalThis as unknown as { sql: unknown }).sql = door;

let subject: Person;
let session: typeof import("@/lib/session");
let actions: typeof import("@/app/actions/oauth");
let tokenActions: typeof import("@/app/actions/tokens");
let fingerprint: typeof import("@/lib/mcp/tokens").fingerprint;
let clientId = "";
let logStart = 0;
const secrets: string[] = [];

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = untyped._load;
  untyped._load = (name, parent, isMain) => {
    if (name === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (name === "next/cache") return { revalidatePath() {} };
    return originalLoad(name, parent, isMain);
  };
}

function readLog(): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    assert.fail(`PULSAR_SERVER_LOG: no server log at ${logPath}; start the server with its output there and the fetch hook of route.ts`);
  }
}

const serverLog = () => readLog().slice(logStart);
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const newVerifier = () => randomBytes(32).toString("base64url");

async function form(fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...asRun },
    body: new URLSearchParams(fields),
  });

  return { status: response.status, body: await response.json(), headers: response.headers };
}

// A code approved by the subject through the consent act, as the screen does.
async function approve(verifier: string): Promise<string> {
  const result = await session.actAs({ id: subject.id, email: subject.email } as never, () =>
    actions.approveAuthorization({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challengeOf(verifier),
      code_challenge_method: "S256",
      state: "s",
      resource: `${siteUrl}/mcp`,
    }),
  );
  assert.ok(result.ok, `approve: ${JSON.stringify(result)}`);
  const code = new URL(result.redirectTo).searchParams.get("code");
  assert.ok(code, "the redirect carries no code");
  assert.match(code, /^plc_[A-Za-z0-9_-]{43}$/);
  secrets.push(code);

  return code;
}

async function exchange(code: string, verifier: string) {
  return form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
}

async function listStatus(accessToken: string): Promise<number> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await response.text();
  if (response.status === 200) assert.match(text, /list_goals/, "tools/list answered without the tools");

  return response.status;
}

function remember(body: Record<string, unknown>): { access: string; refresh: string } {
  const access = body.access_token as string;
  const refresh = body.refresh_token as string;
  secrets.push(access, refresh);

  return { access, refresh };
}

before(async () => {
  assert.ok(siteUrl, "NEXT_PUBLIC_SITE_URL is not set");
  installStubs();
  session = await import("@/lib/session");
  actions = await import("@/app/actions/oauth");
  tokenActions = await import("@/app/actions/tokens");
  ({ fingerprint } = await import("@/lib/mcp/tokens"));
  const runId = await openCheckRun(admin);
  try {
    [subject] = await createPeople(admin, runId, door, 1);
  } catch (error) {
    await close();
    throw error;
  }
  // The control: a call known to reach Auth must show in the log, or the
  // closing assertion reads a log that records nothing.
  await fetch(`${base}/auth/confirm?token_hash=control&type=magiclink`, { redirect: "manual" });
});

let closed = false;

async function close(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    if (clientId) await admin`delete from goals.oauth_clients where id = ${clientId}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
}

after(close);

test("the environment is the server's: its log sees Auth", () => {
  assert.match(readLog(), /\[outbound\].*\/auth\/v1\/verify/, "PULSAR_SERVER_LOG: the server log does not show outbound calls; start the server with the fetch hook of route.ts");
  logStart = readLog().length;
});

test("the metadata parses, names this origin, and its URLs answer", async () => {
  const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "max-age=3600");
  const document = await response.json();
  assert.equal(document.issuer, siteUrl, `NEXT_PUBLIC_SITE_URL is not the issuer this server was built with (${document.issuer}); rebuild with it set, or export the server's`);
  assert.equal(document.authorization_endpoint, `${siteUrl}/oauth/autorizar`);
  assert.equal(document.token_endpoint, `${siteUrl}/oauth/token`);
  assert.equal(document.registration_endpoint, `${siteUrl}/oauth/registro`);
  assert.deepEqual(document.response_types_supported, ["code"]);
  assert.deepEqual(document.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(document.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(document.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(document.client_id_metadata_document_supported, true);

  // 190's resource document names the very issuer served here.
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(resource.authorization_servers, [document.issuer]);

  for (const endpoint of [document.registration_endpoint, document.token_endpoint]) {
    const path = new URL(endpoint).pathname;
    const preflight = await fetch(`${base}${path}`, { method: "OPTIONS" });
    assert.ok(preflight.status < 300, `${path} preflight ${preflight.status}`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    const probe = await fetch(`${base}${path}`, { method: "POST", body: "", headers: asRun });
    assert.equal(probe.status, 400, `${path} answered ${probe.status} to an empty POST`);
    await probe.text();
  }
  const preflight = await fetch(`${base}/.well-known/oauth-authorization-server`, { method: "OPTIONS" });
  assert.ok(preflight.status < 300);
});

test("registration answers 201 with the client, and 400 invalid_client_metadata otherwise", async () => {
  const register = (body: unknown) =>
    fetch(`${base}/oauth/registro`, { method: "POST", headers: { "Content-Type": "application/json", ...asRun }, body: JSON.stringify(body) });

  const created = await register({ client_name: "flow client", redirect_uris: [REDIRECT] });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const body = await created.json();
  assert.match(body.client_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, {
    client_id: body.client_id,
    client_name: "flow client",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  clientId = body.client_id;
  await registerOAuthClient(admin, clientId);
  const [row] = await admin`select client_name as name, redirect_uris from goals.oauth_clients where id = ${clientId}`;
  assert.equal(row.name, "flow client");

  for (const bad of [
    { client_name: "x", redirect_uris: ["http://evil.example/cb"] },
    { client_name: "", redirect_uris: [REDIRECT] },
    { client_name: "x", redirect_uris: [] },
    { client_name: "x" },
    "not an object",
  ]) {
    const refused = await register(bad);
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.deepEqual(await refused.json(), { error: "invalid_client_metadata" });
  }
  const garbage = await fetch(`${base}/oauth/registro`, { method: "POST", body: "{not json", headers: asRun });
  assert.equal(garbage.status, 400);
  await garbage.text();
});

test("register, approve, exchange, list, refresh, revoke", async () => {
  const verifier = newVerifier();
  const code = await approve(verifier);
  secrets.push(verifier);

  const wrong = await exchange(code, newVerifier());
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { error: "invalid_grant" });

  const exchanged = await exchange(code, verifier);
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.headers.get("cache-control"), "no-store");
  assert.equal(exchanged.body.token_type, "Bearer");
  const { ACCESS_TOKEN_SECONDS } = await import("@/lib/oauth/grants");
  assert.equal(exchanged.body.expires_in, ACCESS_TOKEN_SECONDS);
  assert.equal(exchanged.headers.get("pragma"), "no-cache");
  const first = remember(exchanged.body);
  assert.match(first.access, /^plo_[A-Za-z0-9_-]{43}$/);
  assert.match(first.refresh, /^plr_[A-Za-z0-9_-]{43}$/);
  assert.equal(await listStatus(first.access), 200);

  const refreshed = await form({ grant_type: "refresh_token", refresh_token: first.refresh, client_id: clientId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const second = remember(refreshed.body);
  assert.match(second.access, /^plo_[A-Za-z0-9_-]{43}$/);
  assert.match(second.refresh, /^plr_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(second.access, first.access);
  assert.equal(await listStatus(first.access), 401, "the old access token still lists");
  assert.equal(await listStatus(second.access), 200);

  const [row] = await admin`select id from goals.access_tokens where token_hash = ${fingerprint(second.access)}`;
  const revoked = await session.actAs({ id: subject.id, email: subject.email } as never, () =>
    tokenActions.revokeAccessToken({ tokenId: row.id } as never),
  );
  assert.deepEqual(revoked, { ok: true });
  assert.equal(await listStatus(second.access), 401);
});

test("the same code twice answers invalid_grant and revokes what the first issued", async () => {
  const verifier = newVerifier();
  const code = await approve(verifier);
  const first = await exchange(code, verifier);
  assert.equal(first.status, 200);
  const { access } = remember(first.body);
  assert.equal(await listStatus(access), 200);

  const replay = await exchange(code, verifier);
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: "invalid_grant" });
  assert.equal(await listStatus(access), 401, "the replay left the first token alive");
});

test("an unknown refresh token, a foreign client and an unknown grant are refused", async () => {
  const bogus = await form({ grant_type: "refresh_token", refresh_token: "plr_nothing", client_id: clientId });
  assert.deepEqual([bogus.status, bogus.body], [400, { error: "invalid_grant" }]);
  const stranger = await form({ grant_type: "refresh_token", refresh_token: "plr_x", client_id: "not-a-client" });
  assert.deepEqual([stranger.status, stranger.body], [400, { error: "invalid_grant" }]);
  const other = await form({ grant_type: "password", client_id: clientId });
  assert.deepEqual([other.status, other.body], [400, { error: "unsupported_grant_type" }]);
  const missing = await form({ grant_type: "authorization_code", client_id: clientId });
  assert.deepEqual([missing.status, missing.body], [400, { error: "invalid_request" }]);
});

test("a client_id that is no uuid and no https URL is invalid_grant on both grants, as is an unknown uuid", async () => {
  const unknown = "00000000-0000-4000-8000-000000000000";
  for (const id of ["http://client.example/metadata.json", "not-a-client", "ftp://client.example/c", unknown]) {
    const code = await form({ grant_type: "authorization_code", code: "plc_x", code_verifier: newVerifier(), client_id: id, redirect_uri: REDIRECT });
    assert.deepEqual([code.status, code.body], [400, { error: "invalid_grant" }], `code ${id}`);
    const refresh = await form({ grant_type: "refresh_token", refresh_token: "plr_x", client_id: id });
    assert.deepEqual([refresh.status, refresh.body], [400, { error: "invalid_grant" }], `refresh ${id}`);
  }
});

test("a refresh without its token is invalid_request", async () => {
  const response = await form({ grant_type: "refresh_token", client_id: clientId });
  assert.deepEqual([response.status, response.body], [400, { error: "invalid_request" }]);
});

test("every OAuth endpoint answers a cross-origin preflight 204 for any origin and never with credentials", async () => {
  const expected: Record<string, string> = {
    "/oauth/registro": "POST, OPTIONS",
    "/oauth/token": "POST, OPTIONS",
    "/.well-known/oauth-authorization-server": "GET, OPTIONS",
    "/.well-known/oauth-protected-resource": "GET, OPTIONS",
    "/.well-known/oauth-protected-resource/mcp": "GET, OPTIONS",
  };
  for (const [path, methods] of Object.entries(expected)) {
    const response = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } });
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", path);
    assert.equal(response.headers.get("access-control-allow-methods"), methods, path);
    assert.equal(response.headers.get("access-control-allow-credentials"), null, path);
  }
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.headers.get("cache-control"), "max-age=3600", path);
    await response.text();
  }
});

test("/mcp sends no CORS headers, not even to a preflight", async () => {
  const response = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" } });
  await response.text();
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

const leaks = (log: string) =>
  secrets.filter((secret) => log.includes(secret) || log.includes(secret.slice(4)));

test("the server log holds no secret, and the detector sees one when it is there", async () => {
  // The control: the detector must flag a secret planted in what it reads.
  assert.ok(secrets.length >= 8, `only ${secrets.length} secrets were collected`);
  assert.deepEqual(leaks(serverLog() + `\nleak ${secrets[3]}`), [secrets[3]]);

  assert.deepEqual(leaks(serverLog()), []);
});
