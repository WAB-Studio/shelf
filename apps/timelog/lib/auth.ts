import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";

export const signInEmailSchema = z.email().transform((email) => email.trim().toLowerCase());

/**
 * Whether the address is on `timelog.allowed_emails` (RT-08), in one statement. Read before any
 * session exists, so through `db`; the table has no policy and no grant.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    select exists (select 1 from timelog.allowed_emails where email = lower(btrim(${email}))) as allowed`);
  return rows[0]?.allowed === true;
}
