import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { Transaction } from "@/lib/session";

declare const brand: unique symbol;

// Only `resolveBearer` builds one, so nothing can name a person by hand.
export type ResolvedPerson = {
  readonly id: string;
  readonly email: string;
  readonly [brand]: true;
};

const KEY_PREFIX = "pls_";

export function fingerprint(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

// 32 random bytes need no pepper: the digest of a 256-bit value cannot be
// walked back, so the hash alone is what the database keeps.
export function mintKey(): { key: string; hash: Buffer; hint: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");

  return { key, hash: fingerprint(key), hint: key.slice(-4) };
}

/**
 * One statement, outside any transaction and never through Supabase Auth
 * (RNP-14): the function finds the live key, stamps its last use and returns
 * the person in the same round trip. The lookup is by hash equality in the
 * database; nothing here compares secrets.
 */
export async function resolveBearer(token: string): Promise<ResolvedPerson | null> {
  const hash = fingerprint(token);
  const rows = await db.execute<{ user_id: string; email: string }>(
    sql`select user_id, email from goals.person_for_token(${hash})`,
  );
  const row = rows[0];
  if (!row) return null;

  return { id: row.user_id, email: row.email } as ResolvedPerson;
}

/**
 * Inserts under the caller's settled transaction, so the person is whoever
 * that transaction settled as. Columns are named: the table grants INSERT on
 * those four alone.
 */
export async function issueKey(
  tx: Transaction,
  personId: string,
  name: string,
): Promise<{ id: string; key: string; hint: string }> {
  const { key, hash, hint } = mintKey();
  const rows = await tx.execute<{ id: string }>(sql`
    insert into goals.access_tokens (user_id, name, token_hash, hint)
    values (${personId}, ${name}, ${hash}, ${hint})
    returning id`);

  return { id: rows[0].id, key, hint };
}
