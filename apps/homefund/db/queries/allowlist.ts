import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/**
 * Whether the address is on `finances.allowed_emails` (RF-145), in one statement. Asked before
 * any session exists, so it goes through `db` and settles none; the table has no policy.
 * The stored column is lowercase and trimmed by its CHECK, so the bound address is too.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    select exists (select 1 from finances.allowed_emails where email = lower(btrim(${email}))) as allowed`);
  return rows[0]?.allowed === true;
}
