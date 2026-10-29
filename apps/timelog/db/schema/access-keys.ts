import { sql } from "drizzle-orm";
import { check, customType, index, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// A SHA-256 fingerprint: the only form a key is ever stored in (RT-03).
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Revoked, never deleted. `key_hash` is in no SELECT grant; only `timelog.person_for_key` reads it.
export const accessKeys = timeSchema.table(
  "access_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text().notNull(),
    keyHash: bytea().notNull().unique("access_keys_key_hash_unique"),
    hint: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("access_keys_user_id_idx").on(t.userId),
    check("access_keys_name_length", sql`char_length(${t.name}) between 1 and 60`),
    pgPolicy("access_keys_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
    pgPolicy("access_keys_insert_self", { for: "insert", to: authenticatedRole, withCheck: sql`${authUid} = ${t.userId}` }),
    // The check omits `revoked_at is null`, or the update that sets it would fail its own row.
    pgPolicy("access_keys_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId} and ${t.revokedAt} is null`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type AccessKey = typeof accessKeys.$inferSelect;
