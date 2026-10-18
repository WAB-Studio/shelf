import { sql } from "drizzle-orm";
import { check, date, integer, primaryKey } from "drizzle-orm/pg-core";

import { goalsSchema } from "./_schema";
import { bytea } from "./access-tokens";

// Sign-in sends per salted key and Bogotá day (RP-138). RLS on and forced, no policy and no grant: only
// `goals.sign_in_claim` and `goals.sign_in_release` write it.
export const signInClaims = goalsSchema
  .table(
    "sign_in_claims",
    {
      clientKey: bytea().notNull(),
      day: date().notNull(),
      count: integer().notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.clientKey, t.day] }),
      check("sign_in_claims_count_range", sql`${t.count} between 1 and 10000`),
    ],
  )
  .enableRLS();
