import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { reading } from "./_schema";

// What the review keeps for one word or phrase of a reader (RL-93): its FSRS card, the sense the reader tapped to
// learn (RL-85), or the mark of a deletion. One row per key, and the row with the later `at` replaces the other:
// the half a newer row lacks is kept from the older one, a deletion keeps neither. `at` is the device's own clock,
// the last review, tap or deletion that made the row; `updated_at` is the server's and the download cursor.
export const reviewEntries = reading.table(
  "review_entries",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // The record's own key: the lemma reached, or the form as normalised (`lib/review/schedule.ts`).
    key: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
    gone: boolean().notNull().default(false),
    // The device's `ReviewCard` and `SenseChoice` as plain numbers and text, without their `key`.
    card: jsonb(),
    sense: jsonb(),
    // Stamped by the trigger of migration 0011, never granted: no client can move it.
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    // The cursor is the tuple, not the timestamp: one batch ties on `now()` (docs/TRAPS.md).
    index("review_entries_user_id_updated_at_idx").on(t.userId, t.updatedAt, t.key),
    check("review_entries_key_length", sql`length(${t.key}) between 1 and 500`),
    check("review_entries_at_non_negative", sql`${t.at} >= 0`),
    check("review_entries_gone_is_bare", sql`not ${t.gone} or (${t.card} is null and ${t.sense} is null)`),
    check("review_entries_card_shape", sql`jsonb_typeof(${t.card}) = 'object' and length(${t.card}::text) <= 1000`),
    check("review_entries_sense_shape", sql`jsonb_typeof(${t.sense}) = 'object' and length(${t.sense}::text) <= 6000`),
    pgPolicy("review_entries_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("review_entries_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // `using` alone would let a caller hand their row to someone else's id.
    pgPolicy("review_entries_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // «Vaciar aquí y en mi cuenta» empties the reader's rows, and only theirs.
    pgPolicy("review_entries_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type ReviewEntry = typeof reviewEntries.$inferSelect;
