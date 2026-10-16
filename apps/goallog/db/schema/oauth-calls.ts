import { sql } from "drizzle-orm";
import { check, integer, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { goalsSchema } from "./_schema";
import { bytea } from "./access-tokens";

// One counter per address fingerprint and window (RNP-19). RLS on, no policy
// and no grant: only `goals.oauth_claim_call` writes it.
export const oauthCalls = goalsSchema
  .table(
    "oauth_calls",
    {
      bucket: text().notNull(),
      source: bytea().notNull(),
      windowStart: timestamp({ withTimezone: true }).notNull(),
      calls: integer().notNull().default(1),
    },
    (t) => [
      primaryKey({ columns: [t.bucket, t.source, t.windowStart] }),
      check("oauth_calls_bucket_known", sql`${t.bucket} in ('register', 'token')`),
    ],
  )
  .enableRLS();
