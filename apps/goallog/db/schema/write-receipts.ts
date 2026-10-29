import { sql } from "drizzle-orm";
import { jsonb, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";

// What one act answered to one request id (RP-56), so a request sent twice is
// answered from here instead of written twice. Read and inserted by its owner
// alone; no role updates or deletes one. Old rows go through
// `goals.prune_write_receipts`, which `lib/receipts.ts` calls inside its insert.
export const writeReceipts = goalsSchema
  .table(
    "write_receipts",
    {
      userId: uuid()
        .notNull()
        .references(() => authUsers.id, { onDelete: "cascade" }),
      requestId: uuid().notNull(),
      act: text().notNull(),
      answer: jsonb().notNull(),
      // The server's clock, never the caller's: no grant names this column.
      madeAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      // Two people may send the same request id; the replay key is the pair.
      primaryKey({ columns: [t.userId, t.requestId] }),
      pgPolicy("write_receipts_select_self", {
        for: "select",
        to: authenticatedRole,
        using: sql`${authUid} = ${t.userId}`,
      }),
      pgPolicy("write_receipts_insert_self", {
        for: "insert",
        to: authenticatedRole,
        withCheck: sql`${authUid} = ${t.userId}`,
      }),
    ],
  )
  .enableRLS();

export type WriteReceipt = typeof writeReceipts.$inferSelect;
