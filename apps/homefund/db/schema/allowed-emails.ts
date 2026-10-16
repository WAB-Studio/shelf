import { sql } from "drizzle-orm";
import { check, text, timestamp } from "drizzle-orm/pg-core";

import { finances } from "./_schema";

// Who may ask for a sign-in link (RF-145). RLS on, no policy and no grant: read by the server's own
// pool, never by an API role. Stored lowercased and trimmed, so a lookup is an equality. A leader's
// invitation lists its address through a trigger the migration writes by hand.
export const allowedEmails = finances
  .table(
    "allowed_emails",
    {
      email: text().primaryKey(),
      addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      check(
        "allowed_emails_email_shape",
        sql`${table.email} = lower(btrim(${table.email})) and position('@' in ${table.email}) > 1`,
      ),
    ],
  )
  .enableRLS();

export type AllowedEmail = typeof allowedEmails.$inferSelect;
