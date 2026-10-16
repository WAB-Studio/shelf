// Proves RP-38 and RNP-15 at the acts: a key created resolves, revoked it stops
// in the next call, a second revoke and the intruder's answer not-found, and no
// key reaches `console`. Stubs as `acting.ts`.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
(globalThis as unknown as { sql: unknown }).sql = door;

let session: typeof import("@/lib/session");
let tokens: typeof import("@/lib/mcp/tokens");
let actions: typeof import("@/app/actions/tokens");
let subject: Person;
let intruder: Person;
const revalidated: string[] = [];
const logged: string[] = [];
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
const originals = Object.fromEntries(consoleMethods.map((m) => [m, console[m]]));

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath: (path: string) => void revalidated.push(path) };
    return originalLoad(request, parent, isMain);
  };
}

async function rowsNamed(name: string): Promise<number> {
  const [row] = await admin`select count(*)::int as n from goals.access_tokens where name = ${name} and user_id = ${subject.id}`;
  return row.n;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  tokens = await import("@/lib/mcp/tokens");
  actions = await import("@/app/actions/tokens");
  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  for (const method of consoleMethods) {
    console[method] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  }
});

after(async () => {
  for (const method of consoleMethods) console[method] = originals[method] as never;
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("a key created resolves through resolveBearer, and /conexiones is revalidated", async () => {
  const made = await as(subject, () => actions.createAccessToken({ name: "  Claude  " }));
  assert.ok(made.ok, "create refused");
  assert.match(made.key, /^pls_/);
  assert.equal(made.hint, made.key.slice(-4));
  assert.equal((await tokens.resolveBearer(made.key))?.id, subject.id);
  assert.ok(revalidated.includes("/conexiones"));
  assert.equal(await rowsNamed("Claude"), 1, "the name was not stored trimmed");
});

test("revoked, the key stops resolving; revoking it twice answers notFound", async () => {
  const made = await as(subject, () => actions.createAccessToken({ name: "short-lived" }));
  assert.ok(made.ok);
  assert.ok(await tokens.resolveBearer(made.key));
  assert.deepEqual(await as(subject, () => actions.revokeAccessToken({ tokenId: made.id })), { ok: true });
  assert.equal(await tokens.resolveBearer(made.key), null);
  assert.deepEqual(await as(subject, () => actions.revokeAccessToken({ tokenId: made.id })), {
    ok: false,
    error: "connections.errors.notFound",
  });
});

test("the second revoke leaves the first revoked_at untouched", async () => {
  const made = await as(subject, () => actions.createAccessToken({ name: "stamp once" }));
  assert.ok(made.ok);
  await as(subject, () => actions.revokeAccessToken({ tokenId: made.id }));
  const [first] = await admin`select revoked_at from goals.access_tokens where id = ${made.id}`;
  await as(subject, () => actions.revokeAccessToken({ tokenId: made.id }));
  const [second] = await admin`select revoked_at from goals.access_tokens where id = ${made.id}`;
  assert.ok(first.revoked_at);
  assert.equal(second.revoked_at.getTime(), first.revoked_at.getTime());
});

test("revoking the intruder's key answers notFound and it still resolves", async () => {
  const result = await as(subject, () => actions.revokeAccessToken({ tokenId: intruder.keyId }));
  assert.deepEqual(result, { ok: false, error: "connections.errors.notFound" });
  assert.equal((await tokens.resolveBearer(intruder.key))?.id, intruder.id);
});

test("a 61-letter name is refused with its key and writes nothing", async () => {
  const name = "x".repeat(61);
  const result = await as(subject, () => actions.createAccessToken({ name }));
  assert.deepEqual(result, { ok: false, error: "connections.errors.nameTooLong" });
  assert.equal(await rowsNamed(name), 0);
  assert.deepEqual(await as(subject, () => actions.createAccessToken({ name: "  " })), {
    ok: false,
    error: "connections.errors.nameEmpty",
  });
});

test("a live name taken by the same person answers nameTaken; another person may reuse it; a revoked name is free", async () => {
  const first = await as(subject, () => actions.createAccessToken({ name: "twice" }));
  assert.ok(first.ok);
  assert.deepEqual(await as(subject, () => actions.createAccessToken({ name: "twice" })), {
    ok: false,
    error: "connections.errors.nameTaken",
  });
  assert.equal(await rowsNamed("twice"), 1);
  assert.ok((await as(intruder, () => actions.createAccessToken({ name: "twice" }))).ok);
  await as(subject, () => actions.revokeAccessToken({ tokenId: first.id }));
  assert.ok((await as(subject, () => actions.createAccessToken({ name: "twice" }))).ok);
});

test("outside actAs nobody is signed in and both acts refuse", async () => {
  assert.deepEqual(await actions.createAccessToken({ name: "ghost" }), {
    ok: false,
    error: "connections.errors.signedOut",
  });
  assert.deepEqual(await actions.revokeAccessToken({ tokenId: subject.keyId }), {
    ok: false,
    error: "connections.errors.signedOut",
  });
  assert.equal(await tokens.resolveBearer(subject.key).then((p) => p?.id), subject.id);
});

test("no key appears in console output", () => {
  const keys = [subject.key, intruder.key];
  assert.equal(logged.filter((line) => keys.some((key) => line.includes(key))).length, 0);
  assert.equal(logged.filter((line) => /pls_[A-Za-z0-9_-]{20,}/.test(line)).length, 0);
});

test("revoking with a tokenId that is no uuid answers notFound and revokes nothing", async () => {
  const made = await as(subject, () => actions.createAccessToken({ name: "survives a bad id" }));
  assert.ok(made.ok);
  assert.deepEqual(await as(subject, () => actions.revokeAccessToken({ tokenId: "nope" })), {
    ok: false,
    error: "connections.errors.notFound",
  });
  assert.equal((await tokens.resolveBearer(made.key))?.id, subject.id);
});

test("a lapsed name is free, a live one holds it, a revoked one is free", async () => {
  const name = "portátil";
  const lapsed = await as(subject, () => actions.createAccessToken({ name }));
  assert.ok(lapsed.ok);
  await admin`update goals.access_tokens set last_used_at = now() - interval '91 days', created_at = now() - interval '120 days' where id = ${lapsed.id}`;
  const fresh = await as(subject, () => actions.createAccessToken({ name }));
  assert.ok(fresh.ok, "a lapsed key still held its name");

  await admin`update goals.access_tokens set last_used_at = now() where id = ${fresh.id}`;
  assert.deepEqual(await as(subject, () => actions.createAccessToken({ name })), {
    ok: false,
    error: "connections.errors.nameTaken",
  });

  await admin`update goals.access_tokens set revoked_at = now() where name = ${name} and user_id = ${subject.id}`;
  assert.ok((await as(subject, () => actions.createAccessToken({ name }))).ok);
  await admin`delete from goals.access_tokens where name = ${name} and user_id = ${subject.id}`;
});
