// Proves RP-60 (0016): a connection keeps the address its person approved, the
// backfill gives one to connections made before, and `access_token_lapses_at` says
// the same as the doors. Every row is made in a transaction the check rolls back.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql } from "./lib/people";

assertSuiteDatabase();

const admin = adminSql();
const rollback = Symbol("rollback");
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
// Breaks a rule inside the transaction, so a probe can be shown red without touching the database.
const mutant = process.env.CONNECTION_HOST_MUTANT_SQL;

after(() => admin.end());

async function rolledBack(body: (tx: postgres.TransactionSql, person: string) => Promise<void>): Promise<void> {
  const person = randomUUID();
  await admin
    .begin(async (tx) => {
      await tx`insert into auth.users (id, email) values (${person}, ${`${person}@example.invalid`})`;
      if (mutant) await tx.unsafe(mutant);
      await body(tx, person);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}

const hash = () => randomBytes(32);

async function client(tx: postgres.TransactionSql): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select goals.oauth_register_client('Claude', array[${CALLBACK}], null) as id`;
  return row.id;
}

async function grantCode(tx: postgres.TransactionSql, person: string, clientId: string, verifier: string) {
  const code = hash();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await tx`
    insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource)
    values (${person}, ${clientId}, ${code}, ${challenge}, ${CALLBACK}, 'https://r.example.invalid')`;
  return { code, challenge };
}

test("an exchange keeps the address the person approved", async () => {
  await rolledBack(async (tx, person) => {
    const clientId = await client(tx);
    const { code, challenge } = await grantCode(tx, person, clientId, "verifier");
    const access = hash();
    const [{ who }] = await tx<{ who: string | null }[]>`
      select goals.oauth_exchange_code(${code}, ${challenge}, ${clientId}, ${CALLBACK}, ${access}, ${hash()}) as who`;
    assert.equal(who, person);
    const [row] = await tx<{ redirect_uri: string | null }[]>`
      select redirect_uri from goals.access_tokens where token_hash = ${access}`;
    assert.equal(row.redirect_uri, CALLBACK);
  });
});

test("the backfill gives a connection made before its address", async () => {
  const migration = readFileSync(new URL("../../db/migrations/0016_conexion_dominio.sql", import.meta.url), "utf8");
  const backfill = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .find((s) => /^UPDATE\s+"goals"\."access_tokens"/i.test(s) && s.includes("redirect_uri"));
  assert.ok(backfill, "0016 has no backfill statement");
  await rolledBack(async (tx, person) => {
    const clientId = await client(tx);
    const [old] = await tx<{ id: string }[]>`
      insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
      values (${person}, 'oauth', 'Claude', ${hash()}, now() + interval '1 hour') returning id`;
    await tx`
      insert into goals.oauth_codes (user_id, client_id, code_hash, code_challenge, redirect_uri, resource, access_token_id, used_at)
      values (${person}, ${clientId}, ${hash()}, 'c', ${CALLBACK}, 'https://r.example.invalid', ${old.id}, now())`;
    const [personal] = await tx<{ id: string }[]>`
      insert into goals.access_tokens (user_id, name, token_hash, hint)
      values (${person}, 'llave', ${hash()}, 'abcd') returning id`;
    await tx.unsafe(backfill);
    const rows = await tx<{ id: string; redirect_uri: string | null }[]>`
      select id, redirect_uri from goals.access_tokens where id in (${old.id}, ${personal.id})`;
    assert.equal(rows.find((r) => r.id === old.id)?.redirect_uri, CALLBACK);
    assert.equal(rows.find((r) => r.id === personal.id)?.redirect_uri, null);
  });
});

type Lapse = { kind: "personal" | "oauth"; days: number };

// Ages are taken from the transaction's `now()`, so the boundary is exact.
// The four keys of the rule. An OAuth connection lives as long as its last refresh: 90 days.
async function lapsed(tx: postgres.TransactionSql, person: string, { kind, days }: Lapse): Promise<[boolean, boolean]> {
  if (kind === "personal") {
    const token = hash();
    await tx`
      insert into goals.access_tokens (user_id, name, token_hash, hint, last_used_at, created_at)
      values (${person}, 'llave', ${token}, 'abcd', now() - make_interval(days => ${days}), now() - interval '200 days')`;
    const [{ lapses }] = await tx<{ lapses: boolean }[]>`
      select goals.access_token_lapses_at(kind, last_used_at, created_at, expires_at, revoked_at) <= now() as lapses
        from goals.access_tokens where token_hash = ${token}`;
    const opens = (await tx`select * from goals.person_for_token(${token})`).length === 1;
    return [lapses, !opens];
  }
  const clientId = await client(tx);
  const refresh = hash();
  const [access] = await tx<{ id: string }[]>`
    insert into goals.access_tokens (user_id, kind, name, token_hash, expires_at)
    values (${person}, 'oauth', 'c', ${hash()}, now() - make_interval(days => ${days}) + interval '1 hour') returning id`;
  await tx`
    insert into goals.oauth_refresh (access_token_id, client_id, refresh_hash, created_at)
    values (${access.id}, ${clientId}, ${refresh}, now() - make_interval(days => ${days}))`;
  const [{ lapses }] = await tx<{ lapses: boolean }[]>`
    select goals.access_token_lapses_at(kind, last_used_at, created_at, expires_at, revoked_at) <= now() as lapses
      from goals.access_tokens where id = ${access.id}`;
  const [{ who }] = await tx<{ who: string | null }[]>`
    select goals.oauth_refresh_token(${refresh}, ${clientId}, ${hash()}, ${hash()}) as who`;
  return [lapses, who === null];
}

test("the lapse date says what the doors say, for four keys", async () => {
  await rolledBack(async (tx, person) => {
    for (const key of [
      { kind: "personal", days: 89 },
      { kind: "personal", days: 91 },
      { kind: "oauth", days: 89 },
      { kind: "oauth", days: 91 },
    ] as const) {
      const [byFunction, byDoor] = await lapsed(tx, person, key);
      assert.equal(byDoor, key.days === 91, `${key.kind} ${key.days} days: the door`);
      assert.equal(byFunction, byDoor, `${key.kind} ${key.days} days: the function`);
    }
  });
});

test("a revoked key never lapses", async () => {
  await rolledBack(async (tx, person) => {
    const [row] = await tx<{ lapses: Date | null }[]>`
      insert into goals.access_tokens (user_id, name, token_hash, hint, revoked_at)
      values (${person}, 'llave', ${hash()}, 'abcd', now())
      returning goals.access_token_lapses_at(kind, last_used_at, created_at, expires_at, revoked_at) as lapses`;
    assert.equal(row.lapses, null);
  });
});
