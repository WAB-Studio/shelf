// Proves RP-60 at the consent's acts: an approval writes one code for the
// signed-in person, a refusal of any kind writes none, and no redirect ever
// leaves for an address the client did not register. Stubs as `token-actions.ts`.
import assert from "node:assert/strict";
import Module from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
(globalThis as unknown as { sql: unknown }).sql = door;

const REDIRECT = "https://claude.example/api/mcp/auth_callback";
// The caller the consent act sees: a /64 of the documentation prefix, new each run.
const FROM = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
// A public literal, so the read skips DNS; the fetch answers from `served`, never the network.
const CIMD_URL = `https://192.0.2.1/consent-${randomBytes(4).toString("hex")}.json`;
const NEW_REDIRECT = "https://claude.example/api/mcp/second_callback";
let served: unknown = null;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

let session: typeof import("@/lib/session");
let actions: typeof import("@/app/actions/oauth");
let subject: Person;
let clientId: string;
let resource: string;
let site: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

const request = (patch: Record<string, unknown> = {}) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "state with spaces & more=1",
  resource,
  ...patch,
});

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (name, parent, isMain) => {
    if (name === "next/headers") {
      return {
        cookies: async () => ({ getAll: () => [], set() {} }),
        headers: async () => new Headers({ "x-forwarded-for": FROM }),
      };
    }
    if (name === "node:https" || name === "https") {
      const real = originalLoad(name, parent, isMain) as typeof import("node:https");
      return {
        ...real,
        request: (url: unknown, ...rest: unknown[]) => {
          if (String(url) !== CIMD_URL) return (real.request as (...args: unknown[]) => unknown)(url, ...rest);
          const respond = rest.find((one) => typeof one === "function") as (res: unknown) => void;
          const handlers: Record<string, () => void> = {};
          return {
            on: (event: string, handler: () => void) => ((handlers[event] = handler), undefined),
            end: () => {
              const res = Object.assign(Readable.from([Buffer.from(JSON.stringify(served))]), {
                statusCode: 200,
                headers: { "content-type": "application/json" },
              });
              respond(res);
            },
            destroy() {},
          };
        },
      };
    }
    if (name === "next/cache") return { revalidatePath() {} };
    return originalLoad(name, parent, isMain);
  };
}

async function codeRows(): Promise<number> {
  const [row] = await admin`select count(*)::int as n from goals.oauth_codes where user_id = ${subject.id}`;
  return row.n;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  actions = await import("@/app/actions/oauth");
  const { env } = await import("@/lib/env");
  site = env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  resource = `${site}/mcp`;
  const runId = await openCheckRun(admin);
  try {
    [subject] = await createPeople(admin, runId, door, 1);
    const grants = await import("@/lib/oauth/grants");
    clientId = await grants.registerClient({ name: "consent check client", redirectUris: [REDIRECT] });
    await registerOAuthClient(admin, clientId);
  } catch (error) {
    await cleanup();
    throw error;
  }
});

let closed = false;

async function callerSource(): Promise<Buffer> {
  const { callerAddress } = await import("@/lib/oauth/throttle");
  const { fingerprint } = await import("@/lib/mcp/tokens");

  return fingerprint(callerAddress({ headers: new Headers({ "x-forwarded-for": FROM }) }));
}

async function cleanup(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    if (clientId) await admin`delete from goals.oauth_clients where id = ${clientId}`;
    await admin`delete from goals.oauth_clients where metadata_url = ${CIMD_URL}`;
    await admin`delete from goals.oauth_calls where source = ${await callerSource()}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
}

after(cleanup);

async function registerCalls(): Promise<number> {
  const [row] = await admin`
    select coalesce(sum(calls), 0)::int as n from goals.oauth_calls
    where bucket = 'register' and source = ${await callerSource()}`;

  return row.n;
}

test("a client named by a metadata URL spends the caller's registration limit before it is read", async () => {
  const before = await registerCalls();
  // A public literal that answers nothing: the read ends as an unknown client.
  const result = await as(subject, () => actions.approveAuthorization(request({ client_id: "https://192.0.2.1/client.json" })));
  assert.deepEqual(result, { ok: false, error: "oauth.errors.clientUnknown" });
  assert.equal(await registerCalls(), before + 1, "the read did not claim the caller's register bucket");
});

test("a registered metadata client is approved without spending the register limit, and a redirect it added is read again", async () => {
  const document = (redirects: string[]) => ({ client_id: CIMD_URL, client_name: "metadata client", redirect_uris: redirects });
  const approve = (redirect: string) =>
    as(subject, () => actions.approveAuthorization(request({ client_id: CIMD_URL, redirect_uri: redirect })));

  served = document([REDIRECT]);
  const start = await registerCalls();
  assert.ok((await approve(REDIRECT)).ok, "first approval refused");
  assert.equal(await registerCalls(), start + 1, "a new URL did not spend one");

  for (let i = 0; i < 2; i++) assert.ok((await approve(REDIRECT)).ok, `approval ${i} refused`);
  assert.equal(await registerCalls(), start + 1, "a registered client spent the limit");

  served = document([REDIRECT, NEW_REDIRECT]);
  const result = await approve(NEW_REDIRECT);
  assert.ok(result.ok, "a redirect the document added was refused");
  assert.equal(await registerCalls(), start + 2, "the document was not read again");
  assert.equal(new URL(result.redirectTo).origin + new URL(result.redirectTo).pathname, NEW_REDIRECT);
});

test("an approval writes one code for the person and returns the redirect with code, state unchanged and iss", async () => {
  const before = await codeRows();
  const result = await as(subject, () => actions.approveAuthorization(request()));
  assert.ok(result.ok, "approval refused");
  assert.equal(await codeRows(), before + 1);

  const url = new URL(result.redirectTo);
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get("state"), "state with spaces & more=1");
  assert.equal(url.searchParams.get("iss"), site);
  assert.match(url.searchParams.get("code") ?? "", /^plc_/);

  const [row] = await admin`select client_id, redirect_uri, resource, code_challenge from goals.oauth_codes
    where user_id = ${subject.id} and client_id = ${clientId}`;
  assert.equal(row.client_id, clientId);
  assert.equal(row.redirect_uri, REDIRECT);
  assert.equal(row.resource, resource);
  assert.equal(row.code_challenge, CHALLENGE);
});

test("each refusal answers its key and writes no code", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["a redirect the client did not register", { redirect_uri: "https://evil.example/cb" }, "oauth.errors.redirectMismatch"],
    ["a registered redirect with a path appended", { redirect_uri: `${REDIRECT}/x` }, "oauth.errors.redirectMismatch"],
    ["an unknown client", { client_id: randomUUID() }, "oauth.errors.clientUnknown"],
    ["the plain method", { code_challenge_method: "plain" }, "oauth.errors.codeChallengeMethod"],
    ["another resource", { resource: "https://evil.example/mcp" }, "oauth.errors.resource"],
    ["no resource", { resource: undefined }, "oauth.errors.resource"],
    ["a challenge of 42 characters", { code_challenge: CHALLENGE.slice(1) }, "oauth.errors.codeChallenge"],
    ["a challenge of 44 characters", { code_challenge: `${CHALLENGE}A` }, "oauth.errors.codeChallenge"],
    ["a challenge with a plus", { code_challenge: `${CHALLENGE.slice(1)}+` }, "oauth.errors.codeChallenge"],
    ["a token response type", { response_type: "token" }, "oauth.errors.responseType"],
  ];
  const before = await codeRows();
  for (const [label, patch, error] of cases) {
    assert.deepEqual(await as(subject, () => actions.approveAuthorization(request(patch))), { ok: false, error }, label);
  }
  assert.equal(await codeRows(), before);
});

test("nobody signed in is refused and writes no code", async () => {
  const before = await codeRows();
  assert.deepEqual(await actions.approveAuthorization(request()), { ok: false, error: "oauth.errors.signedOut" });
  assert.equal(await codeRows(), before);
});

test("a refusal returns access_denied with the state, writes no code and carries no code", async () => {
  const before = await codeRows();
  const result = await as(subject, () => actions.denyAuthorization(request()));
  assert.ok(result.ok);
  const url = new URL(result.redirectTo);
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("iss"), site);
  assert.equal(url.searchParams.get("state"), "state with spaces & more=1");
  assert.equal(url.searchParams.has("code"), false);
  assert.equal(await codeRows(), before);
});

test("a refusal never redirects to an address the client did not register", async () => {
  for (const patch of [{ redirect_uri: "https://evil.example/cb" }, { client_id: randomUUID() }, { resource: "x" }]) {
    const result = await as(subject, () => actions.denyAuthorization(request(patch)));
    assert.equal(result.ok, false, JSON.stringify(patch));
  }
});

test("a request without state returns a redirect without one", async () => {
  const result = await as(subject, () => actions.denyAuthorization(request({ state: undefined })));
  assert.ok(result.ok);
  assert.equal(new URL(result.redirectTo).searchParams.has("state"), false);
});
