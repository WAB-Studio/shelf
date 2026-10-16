import { sql } from "drizzle-orm";
import { check, date, integer, primaryKey, text } from "drizzle-orm/pg-core";

import { finances } from "./_schema";

// Sign-in links sent per client and Bogotá day (RF-143). Closed like the allowed list: the server's
// own pool counts, no API role reads or writes it.
export const signInClaims = finances
  .table(
    "sign_in_claims",
    {
      clientKey: text().notNull(),
      day: date({ mode: "string" }).notNull(),
      count: integer().notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.clientKey, table.day] }),
      check("sign_in_claims_count_range", sql`${table.count} between 1 and 1000`),
    ],
  )
  .enableRLS();

export type SignInClaim = typeof signInClaims.$inferSelect;
