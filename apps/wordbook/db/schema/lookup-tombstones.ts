import { sql } from "drizzle-orm";
import { check, index, integer, pgPolicy, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { reading } from "./_schema";

// The mark a deleted search leaves behind: its identity, so no device copies it up again, and so every
// other device learns to drop it. Never edited, never removed (migration 0007 grants neither).
export const lookupTombstones = reading.table(
  "lookup_tombstones",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull(),
    localId: integer().notNull(),
    // The deleted row's own `received_at`: what keeps the day's cap from being refunded by a delete.
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    // The server's clock and the download cursor; never granted, so no client can move it.
    deletedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceId, t.localId] }),
    // The cursor is the tuple, not the timestamp: one batch ties on `now()` (docs/TRAPS.md).
    index("lookup_tombstones_user_id_deleted_at_idx").on(t.userId, t.deletedAt, t.deviceId, t.localId),
    check("lookup_tombstones_local_id_positive", sql`${t.localId} > 0`),
    pgPolicy("lookup_tombstones_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("lookup_tombstones_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // No UPDATE and no DELETE policy: a mark is final.
  ],
);

export type LookupTombstone = typeof lookupTombstones.$inferSelect;
