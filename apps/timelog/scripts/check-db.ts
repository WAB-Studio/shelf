// Drives TimeLog's tables on the local stack (RNT-01, RNT-02, RT-02, RT-03): every claim here is a
// statement run, never read off the migration.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { withSettledTransaction } from "@repo/supabase-auth/settled-transaction";

import { fingerprint, mintKey } from "../lib/key-format";

const db = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2, onnotice: () => {} });
const orm = drizzle(db);
type Tx = Parameters<Parameters<typeof orm.transaction>[0]>[0];

type Person = { id: string; key: string; hash: Buffer };
let ana: Person;
let beto: Person;
const day = "2026-10-20";

async function person(): Promise<Person> {
  const id = randomUUID();
  await db`insert into auth.users (id, email, aud, role) values (${id}, ${`${id}@example.invalid`}, 'authenticated', 'authenticated')`;
  const { key, hash, hint } = mintKey();
  await db`insert into timelog.access_keys (user_id, name, key_hash, hint) values (${id}, 'pc', ${hash}, ${hint})`;
  return { id, key, hash };
}

const upload = (who: Person, device: string, days: unknown) =>
  db<{ written: number | null }[]>`select timelog.replace_days(${who.hash}, ${device}, ${JSON.stringify(days)}::jsonb) as written`.then(
    (rows) => rows[0].written,
  );

const appsOf = (who: Person, on: string) =>
  db<{ app: string; seconds: number }[]>`
    select app, seconds from timelog.app_seconds where user_id = ${who.id} and day = ${on} order by app collate "C"`.then((rows) => [...rows]);

// As `authenticated` with `who`'s claims, through the very settle `lib/session.ts` uses.
function asPerson<T>(who: Person, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = { sub: who.id, role: "authenticated", aud: "authenticated" };
  return withSettledTransaction<Tx, T>(
    { claims },
    "check-db",
    "timelog, public",
    (cb) => orm.transaction(cb),
    (tx, statement) => tx.execute(statement),
    fn,
  );
}

// drizzle wraps the driver's error; the refusal is its cause.
const denied = (error: unknown) => /permission denied/.test(String((error as { cause?: Error }).cause?.message));

before(async () => {
  ana = await person();
  beto = await person();
});

after(async () => {
  await db`delete from auth.users where id in ${db([ana.id, beto.id])}`;
  await db.end();
});

test("an upload writes each app's seconds and a second one replaces the day whole (RT-02)", async () => {
  assert.equal(await upload(ana, "pc", [{ day, apps: [{ app: "Code.exe", seconds: 3600 }, { app: "chrome.exe", seconds: 60 }] }]), 2);
  assert.deepEqual(await appsOf(ana, day), [{ app: "Code.exe", seconds: 3600 }, { app: "chrome.exe", seconds: 60 }]);

  assert.equal(await upload(ana, "pc", [{ day, apps: [{ app: "Code.exe", seconds: 4000 }] }]), 1);
  assert.deepEqual(await appsOf(ana, day), [{ app: "Code.exe", seconds: 4000 }]);
});

test("a day with no apps empties it; another device's day stays", async () => {
  await upload(ana, "laptop", [{ day, apps: [{ app: "zoom.exe", seconds: 120 }] }]);
  assert.equal(await upload(ana, "pc", [{ day, apps: [] }]), 0);
  assert.deepEqual(await appsOf(ana, day), [{ app: "zoom.exe", seconds: 120 }]);
});

test("a bad row rolls the whole upload back (RNT-02)", async () => {
  const before = await appsOf(ana, day);
  await assert.rejects(upload(ana, "laptop", [{ day, apps: [{ app: "a", seconds: 0 }] }]));
  assert.deepEqual(await appsOf(ana, day), before);
});

test("an unknown or revoked key writes nothing and stamps nothing (RT-03)", async () => {
  const stranger = { ...ana, hash: fingerprint(mintKey().key) };
  assert.equal(await upload(stranger, "pc", [{ day: "2026-10-21", apps: [{ app: "x", seconds: 5 }] }]), null);

  await db`update timelog.access_keys set revoked_at = now() where user_id = ${beto.id}`;
  assert.equal(await upload(beto, "pc", [{ day, apps: [{ app: "x", seconds: 5 }] }]), null);
  assert.deepEqual(await appsOf(beto, day), []);
  assert.deepEqual(await db`select user_id from timelog.person_for_key(${beto.hash})`.then((rows) => [...rows]), []);
});

test("a person reads their own app-days and none of another's (RNT-01)", async () => {
  await db`insert into timelog.app_seconds (user_id, device, day, app, seconds) values (${beto.id}, 'pc', ${day}, 'beto.exe', 9)`;
  const seen = await asPerson(ana, (tx) => tx.execute<{ user_id: string }>(sql`select distinct user_id from timelog.app_seconds`).then((rows) => rows.map((row) => row.user_id)));
  assert.deepEqual(seen, [ana.id]);
});

test("no API role writes an app-day, calls the upload or reads a key's hash", async () => {
  await assert.rejects(
    asPerson(ana, (tx) => tx.execute(sql`insert into timelog.app_seconds (user_id, device, day, app, seconds) values (${ana.id}, 'pc', ${day}, 'forged', 1)`)),
    denied,
  );
  await assert.rejects(asPerson(ana, (tx) => tx.execute(sql`select timelog.replace_days(${ana.hash}, 'pc', '[]'::jsonb)`)), denied);
  await assert.rejects(asPerson(ana, (tx) => tx.execute(sql`select key_hash from timelog.access_keys`)), denied);
  const names = await asPerson(ana, (tx) => tx.execute(sql`select name from timelog.access_keys`).then((rows) => rows.length));
  assert.equal(names, 1, "the person still lists their own keys");
});
