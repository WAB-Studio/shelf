import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { categories } from "./categories";

// What a user's approvals have taught about one merchant (RF-93, RF-94). Two consecutive approvals under
// the same category make it `trusted`, and a trusted merchant's category prefills a proposal — it never
// records anything. An approval under a different category makes it `ambiguous`, which no later run
// undoes; only the person deleting the row starts the learning over.
//
// `private.remember_ingest_merchant` is the sole writer: `authenticated` holds neither INSERT nor UPDATE,
// so the transition cannot be forged from a client. SELECT and DELETE stay with the person.
export const ingestMerchants = finances.table(
  "ingest_merchants",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Resolved from auth.uid() inside the transition function, never read from its arguments.
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    // The normalised merchant span the fingerprint produced; the label is the same span verbatim.
    merchantKey: text().notNull(),
    merchantLabel: text().notNull(),
    state: text({ enum: ["learning", "trusted", "ambiguous"] })
      .notNull()
      .default("learning"),
    // The category the current run of approvals is on; the streak counts that run.
    candidateCategoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    streak: smallint().notNull().default(0),
    // Cascade, because trust IS the category: nulling this column while `state` stayed 'trusted'
    // is what `ingest_merchants_trusted_category_matches_state` refuses, and the category's
    // deletion was refused with it (RF-63).
    trustedCategoryId: uuid().references(() => categories.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ingest_merchants_state_valid",
      sql`${table.state} in ('learning', 'trusted', 'ambiguous')`,
    ),
    // Trusted and having a trusted category are the same fact, so neither can drift from the other.
    check(
      "ingest_merchants_trusted_category_matches_state",
      sql`(${table.state} = 'trusted') = (${table.trustedCategoryId} is not null)`,
    ),
    // Two consecutive approvals is the whole rule, so the count never runs past it (RF-94).
    check("ingest_merchants_streak_range", sql`${table.streak} between 0 and 2`),
    check(
      "ingest_merchants_merchant_key_length",
      sql`length(${table.merchantKey}) between 1 and 120`,
    ),
    check(
      "ingest_merchants_merchant_label_length",
      sql`length(${table.merchantLabel}) between 1 and 120`,
    ),
    // One memory per merchant per user; the transition function locks exactly this key.
    uniqueIndex("ingest_merchants_owner_merchant_key_unique").on(
      table.ownerUserId,
      table.merchantKey,
    ),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("ingest_merchants_candidate_category_id_idx")
      .on(table.candidateCategoryId)
      .where(sql`${table.candidateCategoryId} is not null`),
    index("ingest_merchants_trusted_category_id_idx")
      .on(table.trustedCategoryId)
      .where(sql`${table.trustedCategoryId} is not null`),
    pgPolicy("ingest_merchants_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    // Forgetting is the only way out of `ambiguous` (RF-94).
    pgPolicy("ingest_merchants_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
  ],
);

export type IngestMerchant = typeof ingestMerchants.$inferSelect;
export type NewIngestMerchant = typeof ingestMerchants.$inferInsert;
