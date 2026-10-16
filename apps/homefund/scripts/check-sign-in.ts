/**
 * RF-145 and RF-143 at the query level: the list lookup and the daily claims the server
 * makes before any session exists (`db/queries/allowlist.ts`, `db/queries/sign-in-claims.ts`).
 *
 * Run: scripts/supabase-local.sh exec npm run --workspace apps/homefund check:sign-in
 * or, without the script entry:
 * TSX_TSCONFIG_PATH=scripts/harness/tsconfig.json node --import tsx --env-file=.env.local scripts/check-sign-in.ts
 *
 * The app's pool is planted here, before the queries load, with a session zone that is never
 * Bogotá's and never UTC's day: a query that asks the session for «today» lands on another day.
 * Every row written is removed by its exact address or key.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import postgres from "postgres";

const salt = process.env.CLIENT_KEY_SALT;
assert.ok(salt && salt.length >= 16, "CLIENT_KEY_SALT must be set: this suite fails, never skips, without it");

const url = process.env.DATABASE_URL!;
const host = new URL(url).hostname;
assert.ok(["127.0.0.1", "localhost"].includes(host), `DATABASE_URL is ${host}, not the local stack`);

// A zone whose calendar day differs from Bogotá's at any hour the suite runs.
const bogotaHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const WRONG_ZONE = bogotaHour >= 5 ? "Pacific/Kiritimati" : "Etc/GMT+12";

let statements = 0;
const appPool = postgres(url, {
  prepare: false,
  max: 4,
  connection: { search_path: "finances, public", TimeZone: WRONG_ZONE },
  debug: () => {
    statements += 1;
  },
});
(globalThis as unknown as { sql: unknown }).sql = appPool;

const fixtures = postgres(url, { prepare: false, max: 2, connection: { search_path: "finances, public" } });

const stamp = randomUUID().slice(0, 8);
const listed: string[] = [];
const keys: string[] = [];
let isEmailAllowed: (email: string) => Promise<boolean>;
let claimSignInLink: (headers: Headers, address: string) => Promise<"ok" | "rateLimited" | "noKey">;
let callerKey: (headers: Headers, salt: string) => string | null;
let addressKey: (address: string, salt: string) => string;
let todayInBogota: () => string;
let clientCap: number;
let addressCap: number;

before(async () => {
  ({ isEmailAllowed } = await import("@/db/queries/allowlist"));
  ({ claimSignInLink } = await import("@/db/queries/sign-in-claims"));
  ({ callerKey, addressKey } = await import("@/lib/auth/client-key"));
  ({ todayInBogota } = await import("@/lib/dates"));
  const { env } = await import("@/lib/env");
  clientCap = env.SIGN_IN_LINK_DAILY_CLIENT_CAP;
  addressCap = env.SIGN_IN_LINK_DAILY_ADDRESS_CAP;
});

after(async () => {
  try {
    if (listed.length) await fixtures`delete from finances.allowed_emails where email in ${fixtures(listed)}`;
    if (keys.length) await fixtures`delete from finances.sign_in_claims where client_key in ${fixtures(keys)}`;
  } finally {
    await appPool.end();
    await fixtures.end();
  }
});

let serial = 0;
function address(): string {
  serial += 1;
  return `check-${stamp}-${serial}@x.invalid`;
}
async function list(email: string) {
  listed.push(email);
  await fixtures`insert into finances.allowed_emails (email) values (${email})`;
}
// A caller no other run shares: a random /64 in 2001:db8::/32.
function caller(): Headers {
  const g = () => randomBytes(2).toString("hex");
  return new Headers({ "x-forwarded-for": `2001:db8:${g()}:${g()}:${g()}::1` });
}
function track(headers: Headers, to: string) {
  keys.push(callerKey(headers, salt!)!, addressKey(to, salt!));
}
async function rowsFor(key: string) {
  return fixtures<{ count: number; day: string }[]>`
    select count, day::text as day from finances.sign_in_claims where client_key = ${key}`;
}

// Mutation: drop lower(btrim()) from the lookup.
test("a listed address is found whatever its case or padding", async () => {
  const email = address();
  await list(email);
  assert.equal(await isEmailAllowed(email), true);
  assert.equal(await isEmailAllowed(`  ${email.toUpperCase()} `), true);
});

// Mutation: exists -> true.
test("an address that is not listed is refused, even one that shares a prefix with a listed one", async () => {
  const email = address();
  await list(email);
  assert.equal(await isEmailAllowed(address()), false);
  assert.equal(await isEmailAllowed(email.replace("@", "x@")), false);
});

// Mutation: `<` -> `<=`, or skip the address claim.
test("one address takes the address cap from any number of callers, then refuses", async () => {
  const to = address();
  const results: string[] = [];
  for (let i = 0; i < addressCap + 1; i += 1) {
    const h = caller();
    track(h, to);
    results.push(await claimSignInLink(h, to.toUpperCase()));
  }
  assert.deepEqual(results, [...Array(addressCap).fill("ok"), "rateLimited"]);
  const [row] = await rowsFor(addressKey(to, salt!));
  assert.equal(row.count, addressCap, "a refused claim must not move the count");
});

// Mutation: skip the caller claim; `<` -> `<=`.
test("one caller takes the caller cap across addresses, then refuses", async () => {
  const h = caller();
  const results: string[] = [];
  const sent: string[] = [];
  for (let i = 0; i < clientCap + 1; i += 1) {
    const to = address();
    track(h, to);
    sent.push(to);
    results.push(await claimSignInLink(h, to));
  }
  assert.deepEqual(results, [...Array(clientCap).fill("ok"), "rateLimited"]);
  const [row] = await rowsFor(callerKey(h, salt!)!);
  assert.equal(row.count, clientCap);

  // Mutation: claim the address first.
  const refusedTo = sent[sent.length - 1];
  assert.equal((await rowsFor(addressKey(refusedTo, salt!))).length, 0, "a refused caller spends no address");
});

// Mutation: select then insert, or any extra statement.
test("a claim is one statement: two round trips for a send, one for a refused caller", async () => {
  const h = caller();
  for (let i = 0; i < clientCap; i += 1) {
    const to = address();
    track(h, to);
    statements = 0;
    assert.equal(await claimSignInLink(h, to), "ok");
    assert.equal(statements, 2);
  }
  const to = address();
  track(h, to);
  statements = 0;
  assert.equal(await claimSignInLink(h, to), "rateLimited");
  assert.equal(statements, 1);
});

// Mutation: fall back to a constant caller key.
test("a request that names no caller gets noKey and writes nothing", async () => {
  const to = address();
  keys.push(addressKey(to, salt!));
  statements = 0;
  assert.equal(await claimSignInLink(new Headers(), to), "noKey");
  assert.equal(statements, 0);
  assert.equal((await rowsFor(addressKey(to, salt!))).length, 0);
});

// Mutation: current_date, which follows the session zone (the pool above is set to another one).
test("the day is Bogotá's, whatever zone the session is in", async () => {
  const h = caller();
  const to = address();
  track(h, to);
  assert.equal(await claimSignInLink(h, to), "ok");
  const [session] = await appPool<{ today: string }[]>`select current_date::text as today`;
  assert.notEqual(session.today, todayInBogota(), "the zone this suite picked must differ from Bogotá's day");
  for (const key of [callerKey(h, salt!)!, addressKey(to, salt!)]) {
    const [row] = await rowsFor(key);
    assert.equal(row.day, todayInBogota());
  }
});

// Mutation: store the key unsalted.
test("neither the caller's address nor the recipient's is stored", async () => {
  const h = caller();
  const to = address();
  track(h, to);
  await claimSignInLink(h, to);
  const stored = await fixtures<{ client_key: string }[]>`
    select client_key from finances.sign_in_claims
    where client_key in ${fixtures([callerKey(h, salt!)!, addressKey(to, salt!)])}`;
  assert.equal(stored.length, 2);
  for (const { client_key } of stored) {
    assert.ok(!client_key.includes(to) && !client_key.includes(h.get("x-forwarded-for")!));
  }
});
