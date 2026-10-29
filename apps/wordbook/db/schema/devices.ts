import { sql } from "drizzle-orm";
import { check, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { reading } from "./_schema";

// A device that has copied to this reader's account. Exists so the list can be
// drawn and so a label survives a device with no rows yet — a `group by` on
// `lookups` would lose exactly that one, the one someone just connected.
export const devices = reading.table(
  "devices",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    deviceId: uuid().notNull(),
    // "chrome:android" — coarse on purpose: browser family and platform codes, both
    // already in every request's user-agent header. No fingerprint, no extra entropy,
    // and no words: the screen translates the codes.
    label: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Pushed on every sync round.
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // A retirement is final (RL-24): the trigger in migration 0004 refuses any change once set.
    retiredAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceId] }),
    check("devices_label_length", sql`length(${t.label}) between 1 and 60`),
    pgPolicy("devices_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("devices_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // `using` alone would let a caller hand their device row to someone else's id.
    pgPolicy("devices_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // No delete policy and no DELETE grant (migration 0004): a retired row is what keeps its id refused.
  ],
);

export type Device = typeof devices.$inferSelect;
