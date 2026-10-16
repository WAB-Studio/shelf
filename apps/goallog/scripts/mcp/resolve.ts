// Proves RNP-14 and RNP-15 at the door's first step: a bearer token becomes
// a person in one statement, and Supabase Auth is never asked. The statement
// count comes off the wire: `@/db/client` reuses `globalThis.sql` when one is
// set, so a `postgres` with `debug` is planted there before the first import.
// No key is ever printed; a failure names the person's role and the key's hint.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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

let resolveBearer: typeof import("@/lib/mcp/tokens").resolveBearer;
let subject: Person;
let intruder: Person;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

before(async () => {
  stubServerOnly();
  ({ resolveBearer } = await import("@/lib/mcp/tokens"));
  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return realFetch(...args);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("the subject's key resolves to the subject, the intruder's to the intruder", async () => {
  const first = await resolveBearer(subject.key);
  assert.equal(first?.id, subject.id, "the subject's key did not resolve to the subject");
  assert.equal(first?.email, subject.email);

  const second = await resolveBearer(intruder.key);
  assert.equal(second?.id, intruder.id, "the intruder's key did not resolve to the intruder");
});

test("a key with one character changed resolves to nobody", async () => {
  const last = subject.key.slice(-1);
  const changed = subject.key.slice(0, -1) + (last === "A" ? "B" : "A");
  assert.equal(await resolveBearer(changed), null);
});

test("an unknown key resolves to nobody", async () => {
  assert.equal(await resolveBearer("pls_" + "x".repeat(43)), null);
});

test("resolving stamps the key's last use", async () => {
  await resolveBearer(subject.key);
  const [row] = await admin`select last_used_at from goals.access_tokens where id = ${subject.keyId}`;
  assert.notEqual(row.last_used_at, null);
});

test("resolution is one statement on the wire and no request leaves for Supabase", async () => {
  await resolveBearer(subject.key); // warm the connection and its type fetch
  wire.length = 0;
  fetchCalls = 0;

  const person = await resolveBearer(subject.key);
  assert.equal(person?.id, subject.id);
  assert.equal(wire.length, 1, `expected one statement, the wire carried ${wire.length}`);
  assert.match(wire[0], /goals\.person_for_token/);
  assert.equal(fetchCalls, 0, "a call left for the network");
});

test("a revoked key resolves to nobody", async () => {
  await admin`update goals.access_tokens set revoked_at = now() where id = ${intruder.keyId}`;
  assert.equal(await resolveBearer(intruder.key), null);
  assert.equal((await resolveBearer(subject.key))?.id, subject.id);
});
