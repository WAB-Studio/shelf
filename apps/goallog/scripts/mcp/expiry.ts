// Proves RP-38 and RP-60 (0015): a key unused for 90 days no longer opens, a
// refresh older than 90 days no longer rotates. Every row is made in a
// transaction the check rolls back.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql } from "./lib/people";

assertSuiteDatabase();

const admin = adminSql();
const rollback = Symbol("rollback");

after(() => admin.end());

async function rolledBack(body: (tx: postgres.TransactionSql, person: string) => Promise<void>): Promise<void> {
  const person = randomUUID();
  await admin
    .begin(async (tx) => {
      await tx`insert into auth.users (id, email) values (${person}, ${`${person}@example.invalid`})`;
      await body(tx, person);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}

const hash = () => randomBytes(32);

async function key(tx: postgres.TransactionSql, person: string, lastUsed: string | null, created: string): Promise<Buffer> {
  const token = hash();
  await tx`
    insert into goals.access_tokens (user_id, name, token_hash, hint, last_used_at, created_at)
    values (${person}, 'llave', ${token}, 'abcd',
      ${lastUsed === null ? null : sqlInterval(lastUsed)}, ${sqlInterval(created)})`;
  return token;
}

// `89 days` -> that long before now; keeps the literal out of the statement text.
function sqlInterval(ago: string): Date {
  return new Date(Date.now() - Number(ago.split(" ")[0]) * 86_400_000);
}

const opens = async (tx: postgres.TransactionSql, token: Buffer) =>
  (await tx`select * from goals.person_for_token(${token})`).length;

test("a key used 89 days ago opens", async () => {
  await rolledBack(async (tx, person) => {
    assert.equal(await opens(tx, await key(tx, person, "89 days", "200 days")), 1);
  });
});

test("a key unused for 91 days does not open and its last use does not move", async () => {
  await rolledBack(async (tx, person) => {
    const token = await key(tx, person, "91 days", "200 days");
    const [before] = await tx<{ at: Date }[]>`select last_used_at as at from goals.access_tokens where token_hash = ${token}`;
    assert.equal(await opens(tx, token), 0);
    const [after] = await tx<{ at: Date }[]>`select last_used_at as at from goals.access_tokens where token_hash = ${token}`;
    assert.equal(after.at.getTime(), before.at.getTime());
  });
});

test("a key never used counts from its creation: 91 days old does not open", async () => {
  await rolledBack(async (tx, person) => {
    assert.equal(await opens(tx, await key(tx, person, null, "91 days")), 0);
    assert.equal(await opens(tx, await key(tx, person, null, "1 days")), 1);
  });
});

async function connection(tx: postgres.TransactionSql, person: string, refreshAge: string) {
  const [client] = await tx<{ id: string }[]>`select goals.oauth_register_client('c', array['https://a.example.invalid/cb'], null) as id`;
  const [access] = await tx<{ id: string }[]>`
    insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
    values (${person}, 'oauth', 'c', ${hash()}, now() + interval '1 hour') returning id`;
  const refresh = hash();
  await tx`
    insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash, created_at)
    values (${access.id}, ${client.id}, ${refresh}, ${sqlInterval(refreshAge)})`;
  return { access: access.id, client: client.id, refresh };
}

const refreshes = async (tx: postgres.TransactionSql, access: string) =>
  (await tx`select 1 from goals.oauth_refresh where access_token_id = ${access}`).length;

test("a refresh 91 days old returns null, adds no refresh and revokes nothing", async () => {
  await rolledBack(async (tx, person) => {
    const c = await connection(tx, person, "91 days");
    const [{ who }] = await tx<{ who: string | null }[]>`
      select goals.oauth_refresh_token(${c.refresh}, ${c.client}, ${hash()}, ${hash()}) as who`;
    assert.equal(who, null);
    assert.equal(await refreshes(tx, c.access), 1);
    const [row] = await tx<{ revoked_at: Date | null }[]>`select revoked_at from goals.access_tokens where id = ${c.access}`;
    assert.equal(row.revoked_at, null);
  });
});

test("a refresh 89 days old returns the person and a new refresh", async () => {
  await rolledBack(async (tx, person) => {
    const c = await connection(tx, person, "89 days");
    const [{ who }] = await tx<{ who: string | null }[]>`
      select goals.oauth_refresh_token(${c.refresh}, ${c.client}, ${hash()}, ${hash()}) as who`;
    assert.equal(who, person);
    assert.equal(await refreshes(tx, c.access), 2);
  });
});
