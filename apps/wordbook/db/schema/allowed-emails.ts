import { sql } from "drizzle-orm";
import { check, text, timestamp } from "drizzle-orm/pg-core";

import { reading } from "./_schema";

// Who may ask for a sign-in link (RL-69). RLS on, no policy and no grant: read by the server's own connection,
// never by an API role. Stored lowercased and trimmed, so a lookup is an equality.
export const allowedEmails = reading
  .table(
    "allowed_emails",
    {
      email: text().primaryKey(),
      addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check(
        "allowed_emails_email_shape",
        sql`${t.email} = lower(btrim(${t.email})) and position('@' in ${t.email}) > 1`,
      ),
    ],
  )
  .enableRLS();
