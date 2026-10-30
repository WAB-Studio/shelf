import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";
import { appUsers } from "./app-users";
import { categories } from "./categories";

// A per-user bearer credential a signed webhook resolves to (RF-90, RF-86); only a hash of the token is
// stored. A default account and category the ingest falls back to when the payload names neither, and a
// per-credential fixed-window rate limit whose window and counter the resolver manages.
export const webhookCredentials = finances.table(
  "webhook_credentials",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Owner is stamped from auth.uid() by a BEFORE INSERT trigger (C2); an ingest writes under this scope.
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    name: text().notNull(),
    // SHA-256 of the bearer token in hex; the token itself is shown once and never stored.
    tokenHash: text().notNull(),
    // Fallbacks the ingest uses when the payload names neither; either may vanish, so both null on delete.
    defaultAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    defaultCategoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    rateLimitPerMin: integer().notNull().default(60),
    // The fixed window's start and its request count; both resolver-managed, not written by the owner.
    rateWindowStartedAt: timestamp({ withTimezone: true }),
    rateCount: integer().notNull().default(0),
    lastUsedAt: timestamp({ withTimezone: true }),
    // What the key opens, fixed when it is minted: `ingest` the webhook (RF-90), `mcp` Claude's
    // door (RF-144). A key never opens the other, so a forwarder's key reads nothing.
    purpose: text().notNull().default("ingest"),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("webhook_credentials_name_length", sql`length(${table.name}) between 1 and 80`),
    check("webhook_credentials_token_hash_length", sql`length(${table.tokenHash}) = 64`),
    check("webhook_credentials_rate_limit_positive", sql`${table.rateLimitPerMin} > 0`),
    check("webhook_credentials_rate_count_non_negative", sql`${table.rateCount} >= 0`),
    check("webhook_credentials_purpose", sql`${table.purpose} in ('ingest', 'mcp')`),
    // The resolver keys on the token hash, so it is unique across every credential.
    uniqueIndex("webhook_credentials_token_hash_unique").on(table.tokenHash),
    index("webhook_credentials_owner_user_id_idx").on(table.ownerUserId),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("webhook_credentials_default_account_id_idx")
      .on(table.defaultAccountId)
      .where(sql`${table.defaultAccountId} is not null`),
    index("webhook_credentials_default_category_id_idx")
      .on(table.defaultCategoryId)
      .where(sql`${table.defaultCategoryId} is not null`),
    // Self-service CRUD: a user only ever sees and writes their own credentials.
    pgPolicy("webhook_credentials_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("webhook_credentials_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("webhook_credentials_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("webhook_credentials_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
  ],
);

export type WebhookCredential = typeof webhookCredentials.$inferSelect;
export type NewWebhookCredential = typeof webhookCredentials.$inferInsert;
