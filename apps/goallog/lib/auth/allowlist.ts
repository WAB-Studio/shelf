import { sql } from "drizzle-orm";

import { db } from "@/db/client";

/**
 * Whether the address is on `goals.allowed_emails` (RP-131), in one statement. Read before any
 * session exists, so it goes through `db` rather than `withGoalsDb`; the table has no policy.
 * The stored column is lowercase and trimmed by its CHECK, so the bound address is too.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    select exists (select 1 from goals.allowed_emails where email = lower(btrim(${email}))) as allowed`);
  return rows[0]?.allowed === true;
}
