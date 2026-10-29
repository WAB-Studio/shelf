import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { fingerprint, mintKey } from "@/lib/key-format";
import type { Transaction } from "@/lib/session";

declare const brand: unique symbol;

// Only `resolveKey` builds one, so nothing names a person by hand.
export type ResolvedPerson = {
  readonly id: string;
  readonly email: string;
  readonly [brand]: true;
};

// One statement through `timelog.person_for_key`, never Supabase Auth; it stamps the key's last use.
export async function resolveKey(key: string): Promise<ResolvedPerson | null> {
  const rows = await db.execute<{ user_id: string; email: string }>(
    sql`select user_id, email from timelog.person_for_key(${fingerprint(key)})`,
  );
  const row = rows[0];
  if (!row) return null;

  return { id: row.user_id, email: row.email } as ResolvedPerson;
}

// Under the caller's settled transaction, so the policies check the person is the caller (RT-06).
export async function issueKey(tx: Transaction, personId: string, name: string): Promise<string> {
  const { key, hash, hint } = mintKey();
  await tx.execute(sql`
    insert into timelog.access_keys (user_id, name, key_hash, hint)
    values (${personId}, ${name}, ${hash}, ${hint})`);

  return key;
}
