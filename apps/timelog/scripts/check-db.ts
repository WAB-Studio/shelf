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

const sitesOf = (who: Person, on: string) =>
  db<{ host: string; seconds: number }[]>`
    select host, seconds from timelog.site_seconds where user_id = ${who.id} and day = ${on} order by host collate "C"`.then((rows) => [...rows]);

const claudeOf = (who: Person, on: string) =>
  db<{ device: string; seconds: number }[]>`
    select device, seconds from timelog.claude_code_seconds where user_id = ${who.id} and day = ${on} order by device collate "C"`.then((rows) => [...rows]);

test("an upload carries sites and Claude Code's seconds, and a second one replaces them whole (RT-13, RT-14)", async () => {
  const on = "2026-10-22";
  const sent = [{ day: on, apps: [{ app: "chrome.exe", seconds: 900 }], sites: [{ host: "claude.ai", seconds: 600 }, { host: "github.com", seconds: 120 }], claude_code_seconds: 1800 }];
  assert.equal(await upload(ana, "pc", sent), 4, "one app, two sites, one Claude Code row");
  assert.deepEqual(await sitesOf(ana, on), [{ host: "claude.ai", seconds: 600 }, { host: "github.com", seconds: 120 }]);
  assert.deepEqual(await claudeOf(ana, on), [{ device: "pc", seconds: 1800 }]);

  assert.equal(await upload(ana, "pc", [{ day: on, apps: [], sites: [{ host: "claude.ai", seconds: 30 }], claude_code_seconds: 60 }]), 2);
  assert.deepEqual(await sitesOf(ana, on), [{ host: "claude.ai", seconds: 30 }]);
  assert.deepEqual(await claudeOf(ana, on), [{ device: "pc", seconds: 60 }]);
});

test("an old payload with no sites or Claude Code leaves what the server has; named and empty clears it (RT-13, RT-14)", async () => {
  const on = "2026-10-22";
  assert.equal(await upload(ana, "pc", [{ day: on, apps: [{ app: "Code.exe", seconds: 5 }] }]), 1);
  assert.deepEqual(await sitesOf(ana, on), [{ host: "claude.ai", seconds: 30 }], "sites untouched");
  assert.deepEqual(await claudeOf(ana, on), [{ device: "pc", seconds: 60 }], "Claude Code untouched");

  assert.equal(await upload(ana, "pc", [{ day: on, apps: [], sites: [], claude_code_seconds: 0 }]), 0);
  assert.deepEqual(await sitesOf(ana, on), []);
  assert.deepEqual(await claudeOf(ana, on), [], "a zero is no row");
});

test("another device's sites and Claude Code day stay when this device replaces its own", async () => {
  const on = "2026-10-23";
  await upload(ana, "pc", [{ day: on, apps: [], sites: [{ host: "a.com", seconds: 9 }], claude_code_seconds: 90 }]);
  await upload(ana, "laptop", [{ day: on, apps: [], sites: [{ host: "b.com", seconds: 8 }], claude_code_seconds: 80 }]);
  await upload(ana, "pc", [{ day: on, apps: [], sites: [], claude_code_seconds: 0 }]);
  assert.deepEqual(await sitesOf(ana, on), [{ host: "b.com", seconds: 8 }]);
  assert.deepEqual(await claudeOf(ana, on), [{ device: "laptop", seconds: 80 }]);
});

test("a site that is no hostname rolls the whole upload back (RNT-02)", async () => {
  const on = "2026-10-24";
  await upload(ana, "pc", [{ day: on, apps: [{ app: "keep.exe", seconds: 7 }] }]);
  await assert.rejects(upload(ana, "pc", [{ day: on, apps: [{ app: "other.exe", seconds: 7 }], sites: [{ host: "github.com/path?q=1", seconds: 5 }] }]));
  assert.deepEqual(await appsOf(ana, on), [{ app: "keep.exe", seconds: 7 }]);
});

test("a revoked or unknown key writes no site and no Claude Code day (RT-03)", async () => {
  const on = "2026-10-25";
  const stranger = { ...ana, hash: fingerprint(mintKey().key) };
  assert.equal(await upload(stranger, "pc", [{ day: on, apps: [], sites: [{ host: "x.com", seconds: 5 }], claude_code_seconds: 5 }]), null);
  assert.equal(await upload(beto, "pc", [{ day: on, apps: [], sites: [{ host: "x.com", seconds: 5 }], claude_code_seconds: 5 }]), null);
  assert.deepEqual(await sitesOf(beto, on), []);
  assert.deepEqual(await claudeOf(beto, on), []);
});

test("a person reads their own sites and Claude Code days and none of another's; no API role writes them (RNT-01)", async () => {
  const on = "2026-10-26";
  await db`insert into timelog.site_seconds (user_id, device, day, host, seconds) values (${beto.id}, 'pc', ${on}, 'beto.dev', 9), (${ana.id}, 'pc', ${on}, 'ana.dev', 9)`;
  await db`insert into timelog.claude_code_seconds (user_id, device, day, seconds) values (${beto.id}, 'pc', ${on}, 9), (${ana.id}, 'pc', ${on}, 9)`;
  const seen = (table: "site_seconds" | "claude_code_seconds") =>
    asPerson(ana, (tx) => tx.execute<{ user_id: string }>(sql`select distinct user_id from ${sql.identifier("timelog")}.${sql.identifier(table)}`).then((rows) => rows.map((row) => row.user_id)));
  assert.deepEqual(await seen("site_seconds"), [ana.id]);
  assert.deepEqual(await seen("claude_code_seconds"), [ana.id]);

  await assert.rejects(
    asPerson(ana, (tx) => tx.execute(sql`insert into timelog.site_seconds (user_id, device, day, host, seconds) values (${ana.id}, 'pc', ${on}, 'forged.dev', 1)`)),
    denied,
  );
  await assert.rejects(
    asPerson(ana, (tx) => tx.execute(sql`insert into timelog.claude_code_seconds (user_id, device, day, seconds) values (${ana.id}, 'laptop', ${on}, 1)`)),
    denied,
  );
  await assert.rejects(asPerson(ana, (tx) => tx.execute(sql`delete from timelog.site_seconds`)), denied);
});
