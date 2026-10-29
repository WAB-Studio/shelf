// Proves RP-38 and RP-60 at the query: inside `actAs` the person reads their
// own keys, live ones first, expired ones then revoked ones, newest first inside
// each, never the fingerprint and never another person's. `expiredAt` is the
// door's 90-day rule (RNP-20, 0015) read forward and agrees with it. Stubs and wire counting as `acting.ts`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, issueKeyFor, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

let session: typeof import("@/lib/session");
let tokens: typeof import("@/lib/queries/tokens");
let subject: Person;
let intruder: Person;
let second: string;
let revoked: string;
let expiryRun: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => [], set() {} }) };
    }
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  tokens = await import("@/lib/queries/tokens");
  const runId = await openCheckRun(admin);
  expiryRun = runId;
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  // Created after `second`, then revoked: newest overall, so only the
  // live-first order can put it last.
  second = (await issueKeyFor(door, subject, "check second")).id;
  revoked = (await issueKeyFor(door, subject, "check revoked")).id;
  await admin`update goals.access_tokens set revoked_at = now() where id = ${revoked}`;
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("two live keys newest first, then the revoked one, the intruder's never", async () => {
  const list = await session.actAs(asResolved(subject), () => tokens.listAccessTokens());
  assert.deepEqual(
    list.map((token) => token.id),
    [second, subject.keyId, revoked],
  );
  assert.ok(!list.some((token) => token.id === intruder.keyId), "the subject read the intruder's key");
});

test("the fields are the contract's, instants are ISO strings, no fingerprint", async () => {
  const list = await session.actAs(asResolved(subject), () => tokens.listAccessTokens());
  const [live, , gone] = list;
  assert.deepEqual(Object.keys(live).sort(), ["createdAt", "expiredAt", "folded", "hint", "id", "kind", "lastUsedAt", "name", "returnHost", "revokedAt"]);
  assert.equal(live.kind, "personal");
  assert.equal(live.name, "check second");
  assert.equal(live.hint?.length, 4);
  assert.equal(live.revokedAt, null);
  assert.equal(live.lastUsedAt, null);
  assert.equal(live.createdAt, new Date(live.createdAt).toISOString());
  assert.equal(gone.revokedAt, new Date(gone.revokedAt!).toISOString());
  assert.ok(!JSON.stringify(list).includes("token_hash"));
});

test("the intruder reads only their own key", async () => {
  const list = await session.actAs(asResolved(intruder), () => tokens.listAccessTokens());
  assert.deepEqual(list.map((token) => token.id), [intruder.keyId]);
});

test("the list is two application statements on the wire", async () => {
  const run = () => session.actAs(asResolved(subject), () => tokens.listAccessTokens());
  await run();
  wire.length = 0;
  await run();
  const application = wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  assert.equal(application.length, 2, `expected two, the wire carried:\n${application.join("\n---\n")}`);
});

const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY + extraMs);

type Seeded = { id: string; hash: Buffer; refresh?: Buffer; client?: string };

async function seedPersonal(person: Person, name: string, lastUsed: Date | null, created: Date, revokedAt?: Date): Promise<Seeded> {
  const hash = randomBytes(32);
  const [row] = await admin<{ id: string }[]>`
    insert into goals.access_tokens (user_id, name, token_hash, hint, last_used_at, created_at, revoked_at)
    values (${person.id}, ${name}, ${hash}, 'abcd', ${lastUsed}, ${created}, ${revokedAt ?? null})
    returning id`;
  return { id: row.id, hash };
}

// Same shape the OAuth grant leaves: `expires_at` an hour past the refresh's birth.
async function seedConnection(person: Person, name: string, lastUse: Date, redirectUri: string | null = null): Promise<Seeded> {
  const hash = randomBytes(32);
  const refresh = randomBytes(32);
  const [client] = await admin<{ id: string }[]>`select goals.oauth_register_client('c', array['https://a.example.invalid/cb'], null) as id`;
  const [row] = await admin<{ id: string }[]>`
    insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at, created_at, redirect_uri)
    values (${person.id}, 'oauth', ${name}, ${hash}, ${new Date(lastUse.getTime() + 3_600_000)}, ${lastUse}, ${redirectUri})
    returning id`;
  await admin`
    insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash, created_at)
    values (${row.id}, ${client.id}, ${refresh}, ${lastUse})`;
  return { id: row.id, hash, refresh, client: client.id };
}

async function doorOpens(seed: Seeded): Promise<boolean> {
  if (seed.refresh) {
    const [{ who }] = await admin<{ who: string | null }[]>`
      select goals.oauth_refresh_token(${seed.refresh}, ${seed.client!}, ${randomBytes(32)}, ${randomBytes(32)}) as who`;
    return who !== null;
  }
  return (await admin`select * from goals.person_for_token(${seed.hash})`).length === 1;
}

// One owner, six keys, read once: each test below asserts one clause of the rule.
let seeded: Promise<{ list: Awaited<ReturnType<typeof tokens.listAccessTokens>>; seeds: Record<string, Seeded>; times: Record<string, Date> }> | undefined;

function fixture() {
  seeded ??= (async () => {
    const [owner] = await createPeople(admin, expiryRun, door, 1);
    const times = { lastUsed91: ago(91), createdNever: ago(100) };
    const seeds: Record<string, Seeded> = {
      stale: await seedPersonal(owner, "stale", times.lastUsed91, ago(200)),
      fresh: await seedPersonal(owner, "fresh", ago(89), ago(200)),
      neverUsed: await seedPersonal(owner, "never used", null, times.createdNever),
      gone: await seedPersonal(owner, "gone", ago(100), ago(200), ago(1)),
      lapsedConnection: await seedConnection(owner, "lapsed connection", ago(90, -1_800_000)),
      liveConnection: await seedConnection(owner, "live connection", ago(89)),
    };
    const list = await session.actAs(asResolved(owner), () => tokens.listAccessTokens());
    return { list, seeds, times };
  })();
  return seeded;
}

async function read(name: string) {
  const { list, seeds, times } = await fixture();
  return { token: list.find((token) => token.id === seeds[name].id)!, seed: seeds[name], list, seeds, times };
}

test("a personal key unused 91 days expires 90 days after its last use", async () => {
  const { token, times } = await read("stale");
  assert.equal(token.expiredAt, new Date(times.lastUsed91.getTime() + 90 * DAY).toISOString());
});

test("a personal key used 89 days ago has not expired", async () => {
  assert.equal((await read("fresh")).token.expiredAt, null);
});

test("a personal key never used counts from its creation", async () => {
  const { token, times } = await read("neverUsed");
  assert.equal(token.expiredAt, new Date(times.createdNever.getTime() + 90 * DAY).toISOString());
});

test("a connection whose last use was 90 days and half an hour ago has expired, one from 89 days ago has not", async () => {
  assert.notEqual((await read("lapsedConnection")).token.expiredAt, null);
  assert.equal((await read("liveConnection")).token.expiredAt, null);
});

test("a revoked key past 90 days is revoked, not expired", async () => {
  const { token } = await read("gone");
  assert.equal(token.expiredAt, null);
  assert.notEqual(token.revokedAt, null);
});

test("the list says expired exactly where the door refuses", async () => {
  const { list, seeds } = await fixture();
  for (const name of ["stale", "fresh", "neverUsed", "lapsedConnection", "liveConnection"]) {
    const token = list.find((entry) => entry.id === seeds[name].id)!;
    assert.equal(token.expiredAt === null, await doorOpens(seeds[name]), `door and list disagree on ${name}`);
  }
});

test("live first, then expired, then revoked, newest first inside each", async () => {
  const { list, seeds } = await fixture();
  const ids = list.filter((token) => Object.values(seeds).some((seed) => seed.id === token.id)).map((token) => token.id);
  const rank = (id: string) => {
    const token = list.find((entry) => entry.id === id)!;
    return token.revokedAt ? 2 : token.expiredAt ? 1 : 0;
  };
  assert.deepEqual(ids.map(rank), [...ids.map(rank)].sort());
  assert.deepEqual(ids.map(rank).filter((r) => r === 1).length, 3);
  const expired = list.filter((token) => token.expiredAt && !token.revokedAt);
  assert.deepEqual(expired.map((token) => token.createdAt), [...expired.map((token) => token.createdAt)].sort().reverse());
});

// Own owner, read once: the host, the fold and the edge of the hour.
let folding: ReturnType<typeof seedFolding> | undefined;

function seedFolding() {
  return (async () => {
    const [owner] = await createPeople(admin, expiryRun, door, 1);
    const seeds: Record<string, Seeded> = {
      claude: await seedConnection(owner, "Claude", ago(1), "https://claude.ai/api/mcp/auth_callback"),
      local: await seedConnection(owner, "Local", ago(2), "http://localhost:33418/callback"),
      noAddress: await seedConnection(owner, "Old grant", ago(3)),
      personal: await seedPersonal(owner, "personal", null, ago(4)),
      revoked31: await seedPersonal(owner, "revoked 31", null, ago(200), ago(31)),
      revoked29: await seedPersonal(owner, "revoked 29", null, ago(200), ago(29)),
      lapsed31: await seedPersonal(owner, "lapsed 31", ago(90 + 31), ago(300)),
      lapsed29: await seedPersonal(owner, "lapsed 29", ago(90 + 29), ago(300)),
      live: await seedPersonal(owner, "live", ago(1), ago(300)),
      // Refresh born 90 days and 30 minutes ago: past the door's line by exactly the hour the mutant forgets.
      pastHour: await seedConnection(owner, "past hour", ago(90, -1_800_000)),
      beforeHour: await seedConnection(owner, "before hour", ago(90, 1_800_000)),
    };
    const list = await session.actAs(asResolved(owner), () => tokens.listAccessTokens());
    return { list, seeds };
  })();
}

async function readFolding(name: string) {
  folding ??= seedFolding();
  const { list, seeds } = await folding;
  return { token: list.find((token) => token.id === seeds[name].id)!, seed: seeds[name] };
}

test("a connection says the host it returns to, port included", async () => {
  assert.equal((await readFolding("claude")).token.returnHost, "claude.ai");
  assert.equal((await readFolding("local")).token.returnHost, "localhost:33418");
});

test("a personal key and a connection with no address have no host", async () => {
  assert.equal((await readFolding("personal")).token.returnHost, null);
  assert.equal((await readFolding("noAddress")).token.returnHost, null);
});

test("folded counts thirty days from when the key stopped working", async () => {
  assert.equal((await readFolding("revoked31")).token.folded, true);
  assert.equal((await readFolding("revoked29")).token.folded, false);
  assert.equal((await readFolding("lapsed31")).token.folded, true);
  assert.equal((await readFolding("lapsed29")).token.folded, false);
  assert.equal((await readFolding("live")).token.folded, false);
});

test("a key created long ago but live is not folded", async () => {
  const { token } = await readFolding("live");
  assert.equal(token.folded, false);
  assert.equal(token.expiredAt, null);
});

test("the hour edge: the list and the door agree 30 minutes either side of 90 days", async () => {
  for (const name of ["pastHour", "beforeHour"]) {
    const { token, seed } = await readFolding(name);
    assert.equal(token.expiredAt === null, await doorOpens(seed), `door and list disagree on ${name}`);
  }
  assert.notEqual((await readFolding("pastHour")).token.expiredAt, null);
  assert.equal((await readFolding("beforeHour")).token.expiredAt, null);
});

test("the list is one application statement besides the session settle", async () => {
  const run = () => session.actAs(asResolved(subject), () => tokens.listAccessTokens());
  await run();
  wire.length = 0;
  await run();
  const application = wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  assert.equal(application.filter((query) => /access_tokens/.test(query)).length, 1, application.join("\n---\n"));
});
