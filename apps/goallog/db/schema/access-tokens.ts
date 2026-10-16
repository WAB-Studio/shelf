import { sql } from "drizzle-orm";
import { check, customType, index, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";

// A SHA-256 fingerprint: the only form in which a credential is ever stored (RNP-15).
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// A personal key or an OAuth connection (RP-38, RP-60). Revoked, never deleted:
// no DELETE grant. `token_hash` is in no SELECT grant; only
// `goals.person_for_token` reads it.
export const accessTokens = goalsSchema.table(
  "access_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    kind: text().notNull().default("personal"),
    // For an `oauth` row, the client's name at consent.
    name: text().notNull(),
    tokenHash: bytea().notNull().unique("access_tokens_token_hash_unique"),
    // Last four characters of a personal key; null for `oauth`.
    hint: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    // Null for a personal key, which lasts until revoked.
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    // Where the person approved the client to return; null for a personal key. Written only by the exchange.
    redirectUri: text(),
  },
  (t) => [
    index("access_tokens_user_id_idx").on(t.userId),
    check("access_tokens_kind_known", sql`${t.kind} in ('personal', 'oauth')`),
    check("access_tokens_name_length", sql`char_length(${t.name}) between 1 and 60`),
    pgPolicy("access_tokens_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    // A person mints personal keys only; an `oauth` row comes from the exchange function.
    pgPolicy("access_tokens_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and ${t.kind} = 'personal'`,
    }),
    // The check omits `revoked_at is null`, or the update that sets it would fail its own row.
    pgPolicy("access_tokens_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId} and ${t.revokedAt} is null`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type AccessToken = typeof accessTokens.$inferSelect;
