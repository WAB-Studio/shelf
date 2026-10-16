// Proves RP-60 and RNP-19: the call limit on the two anonymous OAuth routes and
// the ceiling on unused clients. Drives the lane's running server
// (`PULSAR_BASE_URL`, else :3200 + lane - 1). Every address is a random /64 of
// the documentation prefix, and every assertion is on rows this run made.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { assertSuiteDatabase, closeRun, registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql, openCheckRun, stubServerOnly } from "./lib/people";

assertSuiteDatabase();

const lane = Number(process.env.HARNESS_LANE ?? "1");
const base = (process.env.PULSAR_BASE_URL ?? `http://localhost:${3200 + lane - 1}`).replace(/\/+$/, "");
const REDIRECT = "http://localhost:6274/oauth/callback";
const run = randomBytes(4).toString("hex");

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
(globalThis as unknown as { sql: unknown }).sql = door;

const sources: Buffer[] = [];
let fingerprint: typeof import("@/lib/mcp/tokens").fingerprint;
let callerAddress: typeof import("@/lib/oauth/throttle").callerAddress;

const prefix = () => `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;

// A window that closes mid-run would split a count the check reads whole.
async function outwait(windowSeconds: number, marginSeconds: number): Promise<void> {
  const left = windowSeconds - (Date.now() / 1000) % windowSeconds;
  if (left < marginSeconds) await new Promise((done) => setTimeout(done, (left + 1) * 1000));
}

function remember(address: string): void {
  sources.push(fingerprint(callerAddress({ headers: new Headers({ "x-forwarded-for": address }) })));
}

const register = async (address: string, name: string) => {
  const response = await fetch(`${base}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  });
  if (response.status === 201) await registerOAuthClient(admin, (await response.clone().json()).client_id);

  return response;
};

const garbageToken = (address: string) =>
  fetch(`${base}/oauth/token`, { method: "POST", headers: { "x-forwarded-for": address }, body: "" });

const callsOf = async (address: string, bucket?: string) => {
  const rows = await admin`
    select coalesce(sum(calls), 0)::int as calls from goals.oauth_calls
    where (${bucket ?? null}::text is null or bucket = ${bucket ?? null}) and source = ${fingerprint(callerAddress({ headers: new Headers({ "x-forwarded-for": address }) }))}`;

  return rows[0].calls as number;
};

// The wait is what is left of the window the counter binned the call into.
function assertRefused(response: Response, ceiling: number): void {
  assert.equal(response.status, 429);
  const wait = response.headers.get("retry-after") ?? "";
  assert.match(wait, /^\d+$/, "Retry-After is not whole seconds");
  assert.ok(Number(wait) >= 1 && Number(wait) <= ceiling, `Retry-After ${wait} outside 1..${ceiling}`);
  const left = ceiling - ((Date.now() / 1000) % ceiling);
  assert.ok(
    Number(wait) >= Math.floor(left) && Number(wait) <= Math.ceil(left) + 1,
    `Retry-After ${wait} is not the ${left.toFixed(1)} s left in the window`,
  );
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After");
  assert.equal(response.headers.get("cache-control"), "no-store");
}

before(async () => {
  stubServerOnly();
  await openCheckRun(admin);
  ({ fingerprint } = await import("@/lib/mcp/tokens"));
  ({ callerAddress } = await import("@/lib/oauth/throttle"));
});

after(async () => {
  try {
    await admin`delete from goals.oauth_clients where client_name like ${`limits-${run}-%`}`;
    for (const source of sources) await admin`delete from goals.oauth_calls where source = ${source}`;
    await closeRun(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("ten registrations from one address answer 201, the eleventh 429 and leaves no row", async () => {
  await outwait(3600, 60);
  const a = `${prefix()}::1`;
  remember(a);
  for (let n = 0; n < 10; n += 1) {
    const response = await register(a, `limits-${run}-a${n}`);
    assert.equal(response.status, 201, `registration ${n + 1}`);
    await response.text();
  }
  const refused = await register(a, `limits-${run}-refused`);
  assertRefused(refused, 3600);
  assert.deepEqual(await refused.json(), { error: "too_many_requests" });
  const rows = await admin`select id from goals.oauth_clients where client_name = ${`limits-${run}-refused`}`;
  assert.equal(rows.length, 0, "the refused call left its client");

  const sibling = a.replace(/::1$/, ":0:0:0:2");
  remember(sibling);
  const second = await register(sibling, `limits-${run}-sibling`);
  assertRefused(second, 3600);
  const rowsSibling = await admin`select id from goals.oauth_clients where client_name = ${`limits-${run}-sibling`}`;
  assert.equal(rowsSibling.length, 0);

  const b = `${prefix()}::1`;
  remember(b);
  const other = await register(b, `limits-${run}-b`);
  assert.equal(other.status, 201, "another address was refused");
  await other.text();
});

test("registration bodies that are invalid count too: the eleventh is 429", async () => {
  await outwait(3600, 60);
  const f = `${prefix()}::1`;
  remember(f);
  for (let n = 0; n < 10; n += 1) {
    const response = await fetch(`${base}/oauth/registro`, { method: "POST", headers: { "x-forwarded-for": f }, body: "{not json" });
    assert.equal(response.status, 400, `invalid registration ${n + 1}`);
    await response.text();
  }
  assertRefused(await fetch(`${base}/oauth/registro`, { method: "POST", headers: { "x-forwarded-for": f }, body: "{not json" }), 3600);
});

test("thirty garbage token requests answer 400, the thirty-first 429", async () => {
  await outwait(300, 30);
  const c = `${prefix()}::1`;
  remember(c);
  for (let n = 0; n < 30; n += 1) {
    const response = await garbageToken(c);
    assert.equal(response.status, 400, `token request ${n + 1}`);
    await response.text();
  }
  assertRefused(await garbageToken(c), 300);
});

test("a preflight is never counted", async () => {
  const d = `${prefix()}::1`;
  remember(d);
  for (const path of ["/oauth/registro", "/oauth/token"]) {
    for (let n = 0; n < 40; n += 1) {
      const response = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { "x-forwarded-for": d } });
      assert.equal(response.status, 204);
    }
  }
  assert.equal(await callsOf(d), 0, "an OPTIONS moved the counter");
  const first = await garbageToken(d);
  assert.equal(first.status, 400);
  await first.text();
  assert.equal(await callsOf(d), 1);
});

// A public literal that answers nothing: the claim is all that is observed.
const SILENT = "https://192.0.2.1/client.json";

const grants: Record<string, Record<string, string>> = {
  refresh_token: { grant_type: "refresh_token", refresh_token: "plr_x" },
  authorization_code: {
    grant_type: "authorization_code",
    code: "plc_x",
    code_verifier: "v".repeat(43),
    redirect_uri: REDIRECT,
  },
};

for (const grant of Object.keys(grants)) {
  test(`a ${grant} request naming a new metadata URL spends the registration limit before it reads`, async () => {
    await outwait(3600, 60);
    const e = `${prefix()}::1`;
    remember(e);
    const answer = async () => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "x-forwarded-for": e },
        body: new URLSearchParams({ ...grants[grant], client_id: SILENT }),
      });
      await response.text();

      return response.status;
    };
    const answers = [...(await Promise.all(Array.from({ length: 10 }, answer))), await answer(), await answer()];
    assert.ok(answers.every((status) => status === 400), `answers ${answers}`);
    assert.equal(await callsOf(e, "register"), 12, "the metadata read did not claim the register bucket");
    assert.equal(await callsOf(e, "token"), 12);
  });
}

for (const grant of Object.keys(grants)) {
  test(`a ${grant} request naming a registered metadata URL spends no registration`, async () => {
    await outwait(300, 30);
    const g = `${prefix()}::1`;
    remember(g);
    const known = `https://192.0.2.1/stored-${run}-${grant}.json`;
    await admin`
      insert into goals.oauth_clients (client_name, redirect_uris, metadata_url)
      values (${`limits-${run}-stored-${grant}`}, ${[REDIRECT]}, ${known})`;
    for (let n = 0; n < 11; n += 1) {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "x-forwarded-for": g },
        body: new URLSearchParams({ ...grants[grant], client_id: known }),
      });
      await response.text();
      assert.equal(response.status, 400, `request ${n + 1}`);
    }
    assert.equal(await callsOf(g, "register"), 0, "a registered client spent the register bucket");
    assert.equal(await callsOf(g, "token"), 11);
  });
}

test("the counter table grants nothing to the API roles", async () => {
  const grants = await admin`
    select grantee, privilege_type from information_schema.role_table_grants
    where table_schema = 'goals' and table_name = 'oauth_calls'
      and grantee in ('anon', 'authenticated', 'service_role')`;
  assert.deepEqual(grants.map((row) => `${row.grantee}:${row.privilege_type}`), []);
});

type Tx = postgres.TransactionSql;

// Each scenario runs inside one transaction that always rolls back. It first
// clears the unused clients other runs left, so the ceiling counts this run's alone.
async function rolledBack(body: (tx: Tx) => Promise<void>): Promise<void> {
  const rollback = new Error("rollback");
  try {
    await admin.begin(async (tx) => {
      await tx`
        delete from goals.oauth_clients c
        where not exists (select 1 from goals.oauth_codes k where k.client_id = c.id)
          and not exists (select 1 from goals.oauth_refresh r where r.client_id = c.id)`;
      await body(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function addClient(tx: Tx, name: string, ageSeconds: number, metadataUrl: string | null = null): Promise<string> {
  const [row] = await tx`
    insert into goals.oauth_clients (client_name, redirect_uris, metadata_url, created_at)
    values (${`limits-${run}-${name}`}, ${[REDIRECT]}, ${metadataUrl}, now() - ${ageSeconds} * interval '1 second')
    returning id`;

  return row.id as string;
}

async function addPerson(tx: Tx): Promise<string> {
  const person = randomUUID();
  await tx`
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
    values (${person}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`harness-limits-${person}@example.invalid`}, now(), now())`;

  return person;
}

async function holdWithCode(tx: Tx, person: string, client: string): Promise<void> {
  await tx`
    insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource)
    values (${person}, ${client}, ${randomBytes(32)}, 'c', ${REDIRECT}, 'r')`;
}

async function holdWithRefresh(tx: Tx, person: string, client: string): Promise<void> {
  const [token] = await tx`
    insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
    values (${person}, 'oauth', 'limits', ${randomBytes(32)}, now() + interval '1 hour') returning id`;
  await tx`
    insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash)
    values (${token.id}, ${client}, ${randomBytes(32)})`;
}

const registerIn = async (tx: Tx, name: string, metadataUrl: string | null = null) => {
  const [row] = await tx`select goals.oauth_register_client(${`limits-${run}-${name}`}, ${[REDIRECT]}::text[], ${metadataUrl}) as id`;

  return row.id as string;
};

const exists = async (tx: Tx, name: string) =>
  (await tx`select 1 from goals.oauth_clients where client_name = ${`limits-${run}-${name}`}`).length === 1;

const unusedCount = async (tx: Tx) =>
  (
    await tx`
      select 1 from goals.oauth_clients c
      where not exists (select 1 from goals.oauth_codes k where k.client_id = c.id)
        and not exists (select 1 from goals.oauth_refresh r where r.client_id = c.id)`
  ).length;

// 100 unused clients dated 23 h and a few seconds ago, so the 24 h sweep leaves them be.
async function fillCeiling(tx: Tx): Promise<void> {
  for (let n = 0; n < 100; n += 1) await addClient(tx, `old${n}`, 23 * 3600 + n);
}

test("registering keeps at most one hundred unused clients and drops the oldest", async () => {
  await rolledBack(async (tx) => {
    await fillCeiling(tx);
    const made = await registerIn(tx, "evict");
    assert.equal(await unusedCount(tx), 100, "the ceiling is not exactly one hundred");
    assert.ok(await exists(tx, "evict"), "the new client was dropped");
    assert.equal((await tx`select 1 from goals.oauth_clients where id = ${made}`).length, 1);
    assert.ok(!(await exists(tx, "old99")), "the oldest unused client survived");
    assert.ok(await exists(tx, "old98"), "the second oldest was dropped too");
  });
});

test("the ceiling spares a client holding a code or a refresh row, however old", async () => {
  await rolledBack(async (tx) => {
    await fillCeiling(tx);
    const person = await addPerson(tx);
    await holdWithCode(tx, person, await addClient(tx, "held-code", 23 * 3600 + 2000));
    await holdWithRefresh(tx, person, await addClient(tx, "held-refresh", 23 * 3600 + 2100));
    await registerIn(tx, "evict");
    assert.equal(await unusedCount(tx), 100);
    assert.ok(await exists(tx, "held-code"), "the client with a code was evicted");
    assert.ok(await exists(tx, "held-refresh"), "the client with a refresh row was evicted");
    assert.ok(!(await exists(tx, "old99")), "the oldest unused client survived");
  });
});

test("registering a known metadata URL at the ceiling refreshes its client instead of evicting it", async () => {
  await rolledBack(async (tx) => {
    const url = `https://limits-${run}.example/client.json`;
    const known = await addClient(tx, "known", 23 * 3600 + 2000, url);
    await fillCeiling(tx);
    const made = await registerIn(tx, "renamed", url);
    assert.equal(made, known, "the known client was evicted and registered anew");
    assert.ok(await exists(tx, "renamed"), "the refresh did not rename the client");
    assert.equal((await tx`select 1 from goals.oauth_clients where metadata_url = ${url}`).length, 1);
  });
});

test("registering sweeps unused clients past 24 h and no others", async () => {
  await rolledBack(async (tx) => {
    const person = await addPerson(tx);
    await addClient(tx, "stale", 25 * 3600);
    await addClient(tx, "fresh", 23 * 3600);
    await holdWithCode(tx, person, await addClient(tx, "stale-code", 25 * 3600));
    await holdWithRefresh(tx, person, await addClient(tx, "stale-refresh", 25 * 3600));
    await registerIn(tx, "sweep");
    assert.ok(!(await exists(tx, "stale")), "a 25 h old unused client survived the sweep");
    assert.ok(await exists(tx, "fresh"), "a 23 h old client was swept");
    assert.ok(await exists(tx, "stale-code"), "the sweep took a client with a code");
    assert.ok(await exists(tx, "stale-refresh"), "the sweep took a client with a refresh row");
  });
});
