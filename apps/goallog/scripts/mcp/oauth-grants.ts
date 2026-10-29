// Proves RP-60's statements end to end: register, issue a code as the person,
// exchange it, refresh it, and the revocations a replay brings. A secret is
// never printed; a failure names the step.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const REDIRECT = "http://localhost:6274/oauth/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
// RFC 7636 appendix B, written out so the check does not lean on `challengeOf`.
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

let grants: typeof import("@/lib/oauth/grants");
let resolveBearer: typeof import("@/lib/mcp/tokens").resolveBearer;
let subject: Person;
let clientId: string;
let otherClientId: string;

// Dynamic: `@/db/client` needs `stubServerOnly` first.
async function codeFor(person: Person, redirect = REDIRECT): Promise<string> {
  const { withSettledTransaction } = await import("@/lib/settled-transaction");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("@/db/schema");
  const orm = drizzle(door, { schema, casing: "snake_case" });

  return withSettledTransaction<import("@/lib/session").Transaction, string>(
    { claims: { sub: person.id, role: "authenticated" } },
    "check:mcp",
    "goals, public",
    (fn) => orm.transaction(fn as never) as never,
    (tx, statement) => tx.execute(statement),
    (tx) =>
      grants.issueCode(tx, {
        personId: person.id,
        clientId,
        challenge: CHALLENGE,
        redirectUri: redirect,
        resource: "https://pulsar.example/mcp",
      }),
  );
}

before(async () => {
  stubServerOnly();
  grants = await import("@/lib/oauth/grants");
  ({ resolveBearer } = await import("@/lib/mcp/tokens"));
  const runId = await openCheckRun(admin);
  try {
    [subject] = await createPeople(admin, runId, door, 1);
    clientId = await grants.registerClient({ name: "check client", redirectUris: [REDIRECT] });
    otherClientId = await grants.registerClient({ name: "other check client", redirectUris: [REDIRECT] });
    await registerOAuthClient(admin, clientId);
    await registerOAuthClient(admin, otherClientId);
  } catch (error) {
    await after_();
    throw error;
  }
});

let closed = false;

async function after_(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    const ids = [clientId, otherClientId].filter(Boolean);
    if (ids.length > 0) await admin`delete from goals.oauth_clients where id in ${admin(ids)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
}

after(after_);

test("a code exchanged with the right verifier yields a token that resolves to the person", async () => {
  const code = await codeFor(subject);
  assert.match(code, /^plc_/);
  const issued = await grants.exchangeCode({ code, verifier: VERIFIER, clientId, redirectUri: REDIRECT });
  assert.ok(issued, "the exchange returned nothing");
  assert.match(issued.accessToken, /^plo_/);
  assert.match(issued.refreshToken, /^plr_/);
  assert.equal(issued.expiresIn, 3600);
  assert.equal(issued.personId, subject.id);
  assert.equal((await resolveBearer(issued.accessToken))?.id, subject.id);

  const [row] = await admin`select kind,
      extract(epoch from expires_at - now()) as remaining
    from goals.access_tokens
    where token_hash = ${(await import("@/lib/mcp/tokens")).fingerprint(issued.accessToken)}`;
  assert.equal(row.kind, "oauth");
  assert.ok(
    Math.abs(Number(row.remaining) - issued.expiresIn) < 60,
    `the row lasts ${row.remaining} s, the response says ${issued.expiresIn}`,
  );
});

test("a wrong verifier and a wrong redirect yield nothing and spare the code", async () => {
  const code = await codeFor(subject);
  const other = "A".repeat(43);
  assert.equal(await grants.exchangeCode({ code, verifier: other, clientId, redirectUri: REDIRECT }), null);
  assert.equal(
    await grants.exchangeCode({ code, verifier: VERIFIER, clientId, redirectUri: REDIRECT + "/x" }),
    null,
  );
  // The code survived those refusals.
  assert.ok(await grants.exchangeCode({ code, verifier: VERIFIER, clientId, redirectUri: REDIRECT }));
});

test("a malformed verifier yields nothing and sends no statement", async () => {
  const code = await codeFor(subject);
  wire.length = 0;
  assert.equal(await grants.exchangeCode({ code, verifier: "short", clientId, redirectUri: REDIRECT }), null);
  assert.equal(wire.length, 0, `the wire carried ${wire.length} statement(s)`);
});

// The code row is written through the owner so its expiry can be in the past.
async function plantCode(expiresAt: "past" | "future"): Promise<string> {
  const { fingerprint } = await import("@/lib/mcp/tokens");
  const code = "plc_" + randomBytes(32).toString("base64url");
  await admin`insert into goals.oauth_codes
      (user_id, client_id, code_hash, code_challenge, redirect_uri, resource, expires_at)
    values (${subject.id}, ${clientId}, ${fingerprint(code)}, ${CHALLENGE}, ${REDIRECT},
      'https://pulsar.example/mcp',
      ${expiresAt === "past" ? admin`now() - interval '1 minute'` : admin`now() + interval '5 minutes'`})`;

  return code;
}

test("a code past its expiry yields nothing; the same code unexpired exchanges", async () => {
  const input = { verifier: VERIFIER, clientId, redirectUri: REDIRECT };
  assert.equal(await grants.exchangeCode({ ...input, code: await plantCode("past") }), null);
  assert.ok(await grants.exchangeCode({ ...input, code: await plantCode("future") }));
});

test("an unknown client and another client's exchange yield nothing and spare the code", async () => {
  const code = await codeFor(subject);
  const input = { code, verifier: VERIFIER, redirectUri: REDIRECT };
  assert.equal(await grants.exchangeCode({ ...input, clientId: randomUUID() }), null);
  assert.equal(await grants.exchangeCode({ ...input, clientId: otherClientId }), null);
  assert.ok(await grants.exchangeCode({ ...input, clientId }));
});

test("a refresh rotates: the old access token stops resolving and the new one resolves", async () => {
  const code = await codeFor(subject);
  const first = await grants.exchangeCode({ code, verifier: VERIFIER, clientId, redirectUri: REDIRECT });
  assert.ok(first);

  const second = await grants.refreshToken({ refreshToken: first.refreshToken, clientId });
  assert.ok(second, "the refresh returned nothing");
  assert.notEqual(second.accessToken, first.accessToken);
  assert.equal(await resolveBearer(first.accessToken), null);
  assert.equal((await resolveBearer(second.accessToken))?.id, subject.id);

  const third = await grants.refreshToken({ refreshToken: second.refreshToken, clientId });
  assert.ok(third);
  assert.equal((await resolveBearer(third.accessToken))?.id, subject.id);
});

// Reuse inside this window is a client's retry or race; past it, a replay (Q22 a, 2026-10-18).
const GRACE_SECONDS = 30;

async function connect(): Promise<{ first: import("@/lib/oauth/grants").IssuedTokens }> {
  const code = await codeFor(subject);
  const first = await grants.exchangeCode({ code, verifier: VERIFIER, clientId, redirectUri: REDIRECT });
  assert.ok(first);

  return { first };
}

async function ageRefreshUse(token: string, seconds: number): Promise<void> {
  const { fingerprint } = await import("@/lib/mcp/tokens");
  const rows = await admin`update goals.oauth_refresh set used_at = now() - ${seconds} * interval '1 second'
    where refresh_hash = ${fingerprint(token)} and used_at is not null returning id`;
  assert.equal(rows.length, 1, "no used refresh row to age");
}

async function ageCodeUse(code: string, seconds: number): Promise<void> {
  const { fingerprint } = await import("@/lib/mcp/tokens");
  const rows = await admin`update goals.oauth_codes set used_at = now() - ${seconds} * interval '1 second'
    where code_hash = ${fingerprint(code)} and used_at is not null returning id`;
  assert.equal(rows.length, 1, "no used code row to age");
}

async function revokedAt(accessToken: string): Promise<unknown> {
  const { fingerprint } = await import("@/lib/mcp/tokens");
  const [row] = await admin`select revoked_at from goals.access_tokens where token_hash = ${fingerprint(accessToken)}`;
  assert.ok(row, "the access row is gone");

  return row.revoked_at;
}

test("a refresh presented twice in a row answers nothing the second time and keeps the connection", async () => {
  const { first } = await connect();
  const second = await grants.refreshToken({ refreshToken: first.refreshToken, clientId });
  assert.ok(second);

  assert.equal(await grants.refreshToken({ refreshToken: first.refreshToken, clientId }), null);
  assert.equal((await resolveBearer(second.accessToken))?.id, subject.id);
  const third = await grants.refreshToken({ refreshToken: second.refreshToken, clientId });
  assert.ok(third, "the pair the first call returned stopped refreshing");
  assert.equal((await resolveBearer(third.accessToken))?.id, subject.id);
});

test("a refresh reused inside the window writes nothing to the access row", async () => {
  const { first } = await connect();
  const second = await grants.refreshToken({ refreshToken: first.refreshToken, clientId });
  assert.ok(second);
  await ageRefreshUse(first.refreshToken, GRACE_SECONDS - 1);

  assert.equal(await grants.refreshToken({ refreshToken: first.refreshToken, clientId }), null);
  assert.equal(await revokedAt(second.accessToken), null);
  assert.equal((await resolveBearer(second.accessToken))?.id, subject.id);
});

test("a refresh reused past the window revokes the connection", async () => {
  const { first } = await connect();
  const second = await grants.refreshToken({ refreshToken: first.refreshToken, clientId });
  assert.ok(second);
  await ageRefreshUse(first.refreshToken, GRACE_SECONDS + 1);

  assert.equal(await grants.refreshToken({ refreshToken: first.refreshToken, clientId }), null);
  assert.notEqual(await revokedAt(second.accessToken), null);
  assert.equal(await resolveBearer(second.accessToken), null);
  assert.equal(await grants.refreshToken({ refreshToken: second.refreshToken, clientId }), null);
});

test("a code exchanged twice in a row answers nothing the second time and keeps the first token", async () => {
  const code = await codeFor(subject);
  const input = { code, verifier: VERIFIER, clientId, redirectUri: REDIRECT };
  const first = await grants.exchangeCode(input);
  assert.ok(first);

  assert.equal(await grants.exchangeCode(input), null);
  assert.equal(await revokedAt(first.accessToken), null);
  assert.equal((await resolveBearer(first.accessToken))?.id, subject.id);
  assert.ok(await grants.refreshToken({ refreshToken: first.refreshToken, clientId }));
});

test("a code replayed inside the window spares, past it revokes", async () => {
  const input = { verifier: VERIFIER, clientId, redirectUri: REDIRECT };
  const early = await codeFor(subject);
  const kept = await grants.exchangeCode({ ...input, code: early });
  assert.ok(kept);
  await ageCodeUse(early, GRACE_SECONDS - 1);
  assert.equal(await grants.exchangeCode({ ...input, code: early }), null);
  assert.equal((await resolveBearer(kept.accessToken))?.id, subject.id);

  const late = await codeFor(subject);
  const lost = await grants.exchangeCode({ ...input, code: late });
  assert.ok(lost);
  await ageCodeUse(late, GRACE_SECONDS + 1);
  assert.equal(await grants.exchangeCode({ ...input, code: late }), null);
  assert.notEqual(await revokedAt(lost.accessToken), null);
  assert.equal(await resolveBearer(lost.accessToken), null);
});

test("two refreshes at once on one token yield one pair and one nothing, and the pair resolves", async () => {
  const { fingerprint } = await import("@/lib/mcp/tokens");
  // Each caller on its own connection: the shared door is one connection and would serialise them.
  const a = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const b = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    // A race lands on one try in a few; many rounds make a missing row lock show.
    for (let round = 0; round < 12; round++) await race(round);
  } finally {
    await a.end();
    await b.end();
  }

  async function race(round: number): Promise<void> {
    const { first } = await connect();
    const call = (conn: typeof a) => {
      const access = "plo_" + randomBytes(32).toString("base64url");
      const next = "plr_" + randomBytes(32).toString("base64url");
      return conn`select goals.oauth_refresh_token(${fingerprint(first.refreshToken)}, ${clientId}::uuid,
        ${fingerprint(access)}, ${fingerprint(next)}) as person`.then((r) => ({ person: r[0].person, access, next }));
    };
    const results = await Promise.all([call(a), call(b)]);
    const won = results.filter((r) => r.person);
    assert.equal(won.length, 1, `round ${round}: ${won.length} callers rotated the same token`);
    assert.equal((await resolveBearer(won[0].access))?.id, subject.id);
    assert.ok(await grants.refreshToken({ refreshToken: won[0].next, clientId }));
  }
});

test("the two grant functions stay closed to every role but the owner", async () => {
  const fns = [
    "goals.oauth_refresh_token(bytea,uuid,bytea,bytea)",
    "goals.oauth_exchange_code(bytea,text,uuid,text,bytea,bytea)",
  ];
  for (const fn of fns) {
    for (const role of ["anon", "authenticated", "service_role", "public"]) {
      const [row] = await admin`select has_function_privilege(${role}, ${fn}, 'execute') as ok`;
      assert.equal(row.ok, false, `${role} may execute ${fn}`);
    }
  }
});
