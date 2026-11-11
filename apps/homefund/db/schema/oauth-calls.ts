import { sql } from "drizzle-orm";
import { check, integer, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { finances } from "./_schema";

// One counter per caller fingerprint and window, for the unauthenticated registration (RF-168). RLS on,
// no policy and no grant: only `private.claim_oauth_call` writes it.
export const oauthCalls = finances
  .table(
    "oauth_calls",
    {
      bucket: text().notNull(),
      source: text().notNull(),
      windowStart: timestamp({ withTimezone: true }).notNull(),
      calls: integer().notNull().default(1),
    },
    (table) => [
      primaryKey({ columns: [table.bucket, table.source, table.windowStart] }),
      check("oauth_calls_bucket_known", sql`${table.bucket} in ('register')`),
    ],
  )
  .enableRLS();
