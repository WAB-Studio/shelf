import { sql } from "drizzle-orm";
import { check, text, timestamp } from "drizzle-orm/pg-core";

import { timeSchema } from "./_schema";

// Who may ask for a sign-in link (RT-08). RLS on, no policy and no grant: read by the server's own connection.
export const allowedEmails = timeSchema
  .table(
    "allowed_emails",
    {
      email: text().primaryKey(),
      addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [check("allowed_emails_email_shape", sql`${t.email} = lower(btrim(${t.email})) and position('@' in ${t.email}) > 1`)],
  )
  .enableRLS();
