/**
 * RP-138 at the query level: the daily claims GoalLog's sign-in makes before any session
 * exists (`lib/auth/sign-in-budget.ts` over `goals.sign_in_claim` and `goals.sign_in_release`).
 *
 * Run: scripts/supabase-local.sh exec npm run --workspace apps/goallog check:sign-in
 * or, without the script entry:
 * NODE_PATH=./scripts/node-stubs node --import tsx --env-file=.env.local scripts/check-sign-in.ts
 *
 * The salt and the caps are planted here before the module loads. The app's pool is planted
 * with a session zone that is never Bogotá's day, so a query that asks the session for «today»
 * lands on another day. Every row written is removed by its exact key.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";

import postgres from "postgres";

const CHILD = process.env.CHECK_SIGN_IN_CHILD;
const CLIENT_CAP = 10;
const ADDRESS_CAP = 3;
const stamp = randomUUID().slice(0, 8);
const salt = `check-sign-in-salt-${stamp}`;

delete process.env.VERCEL;
delete process.env.PULSAR_CLOCK;
process.env.SIGN_IN_LINK_DAILY_CLIENT_CAP = String(CLIENT_CAP);
process.env.SIGN_IN_LINK_DAILY_ADDRESS_CAP = String(ADDRESS_CAP);
if (CHILD === "nosalt") delete process.env.CLIENT_KEY_SALT;
else process.env.CLIENT_KEY_SALT = salt;

const url = process.env.DATABASE_URL!;
const host = new URL(url).hostname;
assert.ok(["127.0.0.1", "localhost"].includes(host), `DATABASE_URL is ${host}, not the local stack`);

type Claimed = { day: string; keys: Buffer[] };
type Claim = { status: "ok"; claimed: Claimed } | { status: "capped" } | { status: "noKey" };
type Headers_ = { get(name: string): string | null };

// A zone whose calendar day differs from Bogotá's at any hour the suite runs.
const bogotaHour = Number(
  new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
);
const WRONG_ZONE = bogotaHour >= 5 ? "Pacific/Kiritimati" : "Etc/GMT+12";

let statements = 0;
const appPool = postgres(url, {
  prepare: false,
  max: 4,
  connection: { TimeZone: WRONG_ZONE },
  debug: () => {
    statements += 1;
  },
});
(globalThis as unknown as { sql: unknown }).sql = appPool;
const fixtures = postgres(url, { prepare: false, max: 2 });

let claimSignInLink: (headers: Headers_, address: string) => Promise<Claim>;
let releaseSignInLink: (claimed: Claimed) => Promise<void>;
let todayInZone: () => string;

const mine: Buffer[] = [];

function hmac(value: string): Buffer {
  return createHmac("sha256", salt).update(value).digest();
}
function callerKey(ip: string): Buffer {
  return hmac(`signin:${ip}`);
}
function addressKey(address: string): Buffer {
  return hmac(`signin-to:${address.toLowerCase()}`);
}

let serial = 0;
function address(): string {
  serial += 1;
  return `Check-${stamp}-${serial}@x.invalid`;
}
function ipv4(): string {
  const o = () => 1 + (randomBytes(1)[0] % 254);
  return `10.${o()}.${o()}.${o()}`;
}
function caller(ip = ipv4()): { headers: Headers_; ip: string } {
  const headers = new Map([["x-forwarded-for", ip]]);
  return { headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, ip };
}
function track(ip: string, to: string) {
  mine.push(callerKey(ip), addressKey(to));
}
async function rowsFor(key: Buffer) {
  const rows = await fixtures<{ count: number; day: string }[]>`
    select count, day::text as day from goals.sign_in_claims where client_key = ${key} order by day`;
  return rows.map(({ count, day }) => ({ count, day }));
}
async function dayBefore(day: string): Promise<string> {
  return (await fixtures<{ d: string }[]>`select (${day}::date - 1)::text as d`)[0].d;
}

async function childProbe(): Promise<void> {
  // Spawned by the «no salt» test: the module loads without a salt and reports what it answered.
  const { claimSignInLink: claim } = await import("@/lib/auth/sign-in-budget");
  const { headers } = caller(process.env.CHECK_SIGN_IN_IP);
  let out: unknown;
  try {
    out = { answered: await claim(headers, process.env.CHECK_SIGN_IN_ADDRESS!) };
  } catch (error) {
    out = { threw: String(error) };
  }
  console.log(`RESULT ${JSON.stringify(out)}`);
  await appPool.end();
  await fixtures.end();
}
const isChild = CHILD === "nosalt";
if (isChild) void childProbe();

before(async () => {
  if (isChild) return;
  ({ claimSignInLink, releaseSignInLink } = await import("@/lib/auth/sign-in-budget"));
  ({ todayInZone } = await import("@/lib/zone"));
});

after(async () => {
  if (isChild) return;
  try {
    if (mine.length) await fixtures`delete from goals.sign_in_claims where client_key in ${fixtures(mine)}`;
  } finally {
    await appPool.end();
    await fixtures.end();
  }
});

// Mutation: cap off by one (`<=`).
test("a caller's 11th claim of a day is refused, the first ten to ten addresses pass", async () => {
  const { headers, ip } = caller();
  const results: string[] = [];
  for (let i = 0; i < CLIENT_CAP + 1; i += 1) {
    const to = address();
    track(ip, to);
    results.push((await claimSignInLink(headers, to)).status);
  }
  assert.deepEqual(results, [...Array(CLIENT_CAP).fill("ok"), "capped"]);
  assert.deepEqual(await rowsFor(callerKey(ip)), [{ count: CLIENT_CAP, day: todayInZone() }]);
});

// Mutation: claim only the caller; address `<=`; key the address without lower-casing.
test("an address's 4th claim of a day is refused whatever its case, from any caller", async () => {
  const to = address();
  const results: string[] = [];
  for (let i = 0; i < ADDRESS_CAP + 1; i += 1) {
    const c = caller();
    track(c.ip, to);
    results.push((await claimSignInLink(c.headers, i % 2 ? to.toUpperCase() : to.toLowerCase())).status);
  }
  assert.deepEqual(results, [...Array(ADDRESS_CAP).fill("ok"), "capped"]);
  assert.deepEqual(await rowsFor(addressKey(to)), [{ count: ADDRESS_CAP, day: todayInZone() }]);
});

// Mutation: claim the address first.
test("a caller at its cap spends nothing of a new address's cap", async () => {
  const { headers, ip } = caller();
  for (let i = 0; i < CLIENT_CAP; i += 1) {
    const to = address();
    track(ip, to);
    assert.equal((await claimSignInLink(headers, to)).status, "ok");
  }
  const fresh = address();
  track(ip, fresh);
  assert.deepEqual(await claimSignInLink(headers, fresh), { status: "capped" });
  assert.equal((await rowsFor(addressKey(fresh))).length, 0, "the refused caller left the address's row absent");
});

// Mutation: throw, or answer `capped`, or write a row under an undefined salt.
test("with no salt the claim answers noKey and writes no row", async () => {
  const ip = ipv4();
  const to = address();
  track(ip, to);
  const run = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CHECK_SIGN_IN_CHILD: "nosalt", CHECK_SIGN_IN_IP: ip, CHECK_SIGN_IN_ADDRESS: to },
    timeout: 60_000,
  });
  const line = /^RESULT (.*)$/m.exec(run.stdout)?.[1];
  assert.ok(line, `the child answered nothing: ${run.stdout}\n${run.stderr}`);
  assert.deepEqual(JSON.parse(line), { answered: { status: "noKey" } });
  assert.equal((await rowsFor(callerKey(ip))).length, 0);
  assert.equal((await rowsFor(addressKey(to))).length, 0);
});

// Mutation: release only the caller; release the address twice; claimed keys in another order.
test("a claim then its release leaves the caller and the address where they were", async () => {
  const { headers, ip } = caller();
  const other = address();
  const to = address();
  track(ip, other);
  track(ip, to);
  assert.equal((await claimSignInLink(headers, other)).status, "ok");
  const priorCaller = await rowsFor(callerKey(ip));
  assert.equal(priorCaller[0].count, 1);

  // The address already holds one send from elsewhere.
  const c2 = caller();
  track(c2.ip, to);
  assert.equal((await claimSignInLink(c2.headers, to)).status, "ok");
  const priorAddress = await rowsFor(addressKey(to));

  const claim = await claimSignInLink(headers, to);
  assert.ok(claim.status === "ok");
  assert.equal(claim.claimed.day, todayInZone());
  assert.equal(claim.claimed.keys.length, 2);
  assert.ok(claim.claimed.keys.some((k) => k.equals(callerKey(ip))));
  assert.ok(claim.claimed.keys.some((k) => k.equals(addressKey(to))));
  assert.equal((await rowsFor(callerKey(ip)))[0].count, 2);
  assert.equal((await rowsFor(addressKey(to)))[0].count, 2);

  await releaseSignInLink(claim.claimed);
  assert.deepEqual(await rowsFor(callerKey(ip)), priorCaller);
  assert.deepEqual(await rowsFor(addressKey(to)), priorAddress);
});

// Mutation: one call per key.
test("a release is one statement whatever the number of keys", async () => {
  const { headers, ip } = caller();
  const to = address();
  track(ip, to);
  const claim = await claimSignInLink(headers, to);
  assert.ok(claim.status === "ok");
  statements = 0;
  await releaseSignInLink(claim.claimed);
  assert.equal(statements, 1);
});

test("releasing no keys does nothing", async () => {
  statements = 0;
  await releaseSignInLink({ day: todayInZone(), keys: [] });
  assert.equal(statements, 0);
});

// Mutation: release by key alone (the delete or the update drops `day =`).
test("a release of today's claim leaves the same keys' rows on other days", async () => {
  const { headers, ip } = caller();
  const to = address();
  track(ip, to);
  const today = todayInZone();
  const yesterday = await dayBefore(today);

  process.env.PULSAR_CLOCK = yesterday;
  let first: Claim;
  try {
    first = await claimSignInLink(headers, to);
  } finally {
    delete process.env.PULSAR_CLOCK;
  }
  assert.ok(first.status === "ok");
  assert.equal(first.claimed.day, yesterday);

  // Yesterday's rows at 1 (the delete branch) and a second pair at 3 (the update branch).
  const [high, highTo] = [callerKey(`high-${stamp}`), addressKey(`high-${stamp}@x.invalid`)];
  mine.push(high, highTo);
  await fixtures`insert into goals.sign_in_claims (client_key, day, count) values
    (${high}, ${yesterday}, 3), (${highTo}, ${yesterday}, 3), (${high}, ${today}, 3), (${highTo}, ${today}, 3)`;

  const second = await claimSignInLink(headers, to);
  assert.ok(second.status === "ok");
  assert.equal(second.claimed.day, today);
  await releaseSignInLink(second.claimed);
  assert.deepEqual(await rowsFor(callerKey(ip)), [{ count: 1, day: yesterday }]);
  assert.deepEqual(await rowsFor(addressKey(to)), [{ count: 1, day: yesterday }]);

  await releaseSignInLink({ day: today, keys: [high, highTo] });
  assert.deepEqual(await rowsFor(high), [
    { count: 3, day: yesterday },
    { count: 2, day: today },
  ]);
  assert.deepEqual(await rowsFor(highTo), [
    { count: 3, day: yesterday },
    { count: 2, day: today },
  ]);
});

// Mutation: `new Date().toISOString().slice(0, 10)`, `current_date`.
test("at 23:30 in Bogotá the claim's day is Bogotá's, not UTC's next day", async () => {
  const { headers, ip } = caller();
  const to = address();
  track(ip, to);
  // 2026-03-09 23:30 Bogotá is 2026-03-10 04:30 UTC.
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-10T04:30:00Z") });
  let claim: Claim;
  try {
    claim = await claimSignInLink(headers, to);
  } finally {
    mock.timers.reset();
  }
  assert.ok(claim.status === "ok");
  assert.equal(claim.claimed.day, "2026-03-09");
  assert.deepEqual(await rowsFor(callerKey(ip)), [{ count: 1, day: "2026-03-09" }]);
  assert.deepEqual(await rowsFor(addressKey(to)), [{ count: 1, day: "2026-03-09" }]);
});

// Mutation: drop the salt (the key becomes a bare digest of the address).
test("the stored keys are the salted HMACs, never a bare digest of the address or the IP", async () => {
  const { headers, ip } = caller();
  const to = address();
  track(ip, to);
  assert.equal((await claimSignInLink(headers, to)).status, "ok");
  const stored = await fixtures<{ client_key: Buffer }[]>`
    select client_key from goals.sign_in_claims
    where client_key in ${fixtures([callerKey(ip), addressKey(to)])}`;
  assert.equal(stored.length, 2, "both keys are the HMAC of the namespaced values");
  const bare = [ip, to, to.toLowerCase(), `signin:${ip}`, `signin-to:${to.toLowerCase()}`].flatMap((v) => [
    createHash("sha256").update(v).digest(),
    Buffer.from(v),
  ]);
  const found = await fixtures`select 1 from goals.sign_in_claims where client_key in ${fixtures(bare)}`;
  assert.equal(found.length, 0);
});
