import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
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
import { recipients } from "./recipients";
import { transactions } from "./transactions";
import { webhookCredentials } from "./webhook-credentials";

// A webhook delivery parked as a proposal (RF-90): it is never a movement until a person accepts it,
// and the row survives the decision so a re-delivery of the same reference lands on nothing new. Every
// `proposed_*` column is what the interpreter read, not what will be written — the movement is recorded
// through the ordinary insert path, which derives its kind from the accounts.
export const ingestDeliveries = finances.table(
  "ingest_deliveries",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Owner is stamped from auth.uid() by a BEFORE INSERT trigger; a delivery is personal, never a group's.
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    // The credential the delivery arrived through; revoking it must not erase the history it carried.
    credentialId: uuid().references(() => webhookCredentials.id, { onDelete: "set null" }),
    // The idempotency key: the payload's own reference, or the content hash the ingest derives (RF-90).
    externalRef: text().notNull(),
    // The bank SMS verbatim, so a person reviews what actually arrived rather than a reading of it.
    rawText: text().notNull(),
    // SHA-256 hex of the masked message, the key the shape memory silences on (RF-92).
    shapeHash: text().notNull(),
    // The merchant span the fingerprint found, normalised as a key and kept verbatim as a label (RF-93).
    merchantKey: text(),
    merchantLabel: text(),
    // The trigger below decides this on insert, never the caller.
    status: text({ enum: ["pending", "accepted", "rejected"] })
      .notNull()
      .default("pending"),
    // The shape memory resolved this delivery on arrival (RF-92); no person ever saw it, so RF-99 may
    // return it to the queue. A rejection a person made never carries this.
    silencedOnArrival: boolean().notNull().default(false),
    // The movement an acceptance recorded; cleared if that movement is deleted, leaving the decision.
    transactionId: uuid().references(() => transactions.id, { onDelete: "set null" }),
    proposedAmountCents: bigint({ mode: "number" }),
    proposedAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    proposedCategoryId: uuid().references(() => categories.id, { onDelete: "set null" }),
    // Where the proposed category came from, so the review can say why it is offered (RF-93).
    categorySource: text({ enum: ["merchant", "interpreter", "credential_default", "recipient"] }),
    // `transfer` only when a saved recipient says both sides are the person's accounts (RF-189).
    proposedDirection: text({ enum: ["income", "expense", "transfer"] }),
    // The account a transfer lands in; `proposed_account_id` is then the one it leaves.
    proposedToAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    // The number the message names (digits, whole or a tail) and the saved recipient it matched uniquely.
    extractedIdentifier: text(),
    recipientId: uuid().references(() => recipients.id, { onDelete: "set null" }),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end, never a JS Date.
    proposedOccurredAt: date({ mode: "string" }),
    proposedDescription: text(),
    // Why the channel refused the message before any person saw it (RF-196); null on every other row.
    rejectReason: text({
      enum: ["failed", "statement", "support", "reminder", "promotion", "no_movement_signal"],
    }),
    // Stamped when the delivery leaves the queue, in either direction.
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ingest_deliveries_status_valid",
      sql`${table.status} in ('pending', 'accepted', 'rejected')`,
    ),
    // Pending and unresolved are the same fact, so neither can drift from the other.
    check(
      "ingest_deliveries_resolved_at_matches_status",
      sql`(${table.status} = 'pending') = (${table.resolvedAt} is null)`,
    ),
    // A restored delivery cannot keep the flag, so a pending row is a pending row and the queue never
    // grows a second class of card.
    check(
      "ingest_deliveries_silenced_only_when_rejected",
      sql`${table.silencedOnArrival} = false or ${table.status} = 'rejected'`,
    ),
    // Only an acceptance names a movement; a rejection never carries one.
    check(
      "ingest_deliveries_transaction_only_when_accepted",
      sql`${table.transactionId} is null or ${table.status} = 'accepted'`,
    ),
    check("ingest_deliveries_raw_text_length", sql`length(${table.rawText}) between 1 and 500`),
    check("ingest_deliveries_shape_hash_length", sql`length(${table.shapeHash}) = 64`),
    check(
      "ingest_deliveries_external_ref_length",
      sql`length(${table.externalRef}) between 1 and 200`,
    ),
    check("ingest_deliveries_merchant_key_length", sql`length(${table.merchantKey}) <= 120`),
    check("ingest_deliveries_merchant_label_length", sql`length(${table.merchantLabel}) <= 120`),
    check(
      "ingest_deliveries_proposed_description_length",
      sql`length(${table.proposedDescription}) <= 200`,
    ),
    // The amount is always positive; the direction supplies the sign, as on a movement (RF-20).
    check(
      "ingest_deliveries_proposed_amount_positive",
      sql`${table.proposedAmountCents} is null or ${table.proposedAmountCents} > 0`,
    ),
    check(
      "ingest_deliveries_proposed_direction_valid",
      sql`${table.proposedDirection} is null or ${table.proposedDirection} in ('income', 'expense', 'transfer')`,
    ),
    check(
      "ingest_deliveries_category_source_valid",
      sql`${table.categorySource} is null or ${table.categorySource} in ('merchant', 'interpreter', 'credential_default', 'recipient')`,
    ),
    // A proposed category always says where it came from, so none is ever offered unexplained.
    check(
      "ingest_deliveries_category_source_present",
      sql`${table.proposedCategoryId} is null or ${table.categorySource} is not null`,
    ),
    check(
      "ingest_deliveries_reject_reason_valid",
      sql`${table.rejectReason} is null or ${table.rejectReason} in ('failed', 'statement', 'support', 'reminder', 'promotion', 'no_movement_signal')`,
    ),
    // The idempotency key (RF-90): a re-delivery of the same reference is refused, not duplicated.
    uniqueIndex("ingest_deliveries_owner_external_ref_unique").on(
      table.ownerUserId,
      table.externalRef,
    ),
    index("ingest_deliveries_owner_status_idx").on(table.ownerUserId, table.status),
    index("ingest_deliveries_owner_shape_hash_idx").on(table.ownerUserId, table.shapeHash),
    index("ingest_deliveries_owner_merchant_key_idx")
      .on(table.ownerUserId, table.merchantKey)
      .where(sql`${table.merchantKey} is not null`),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("ingest_deliveries_transaction_id_idx")
      .on(table.transactionId)
      .where(sql`${table.transactionId} is not null`),
    index("ingest_deliveries_credential_id_idx")
      .on(table.credentialId)
      .where(sql`${table.credentialId} is not null`),
    index("ingest_deliveries_proposed_account_id_idx")
      .on(table.proposedAccountId)
      .where(sql`${table.proposedAccountId} is not null`),
    check(
      "ingest_deliveries_extracted_identifier_digits",
      sql`${table.extractedIdentifier} is null or ${table.extractedIdentifier} ~ '^[0-9]{4,20}$'`,
    ),
    index("ingest_deliveries_proposed_to_account_id_idx")
      .on(table.proposedToAccountId)
      .where(sql`${table.proposedToAccountId} is not null`),
    index("ingest_deliveries_recipient_id_idx")
      .on(table.recipientId)
      .where(sql`${table.recipientId} is not null`),
    index("ingest_deliveries_proposed_category_id_idx")
      .on(table.proposedCategoryId)
      .where(sql`${table.proposedCategoryId} is not null`),
    pgPolicy("ingest_deliveries_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("ingest_deliveries_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("ingest_deliveries_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    // No delete policy: a delivery is history, and dropping it would reopen an idempotency key.
  ],
);

export type IngestDelivery = typeof ingestDeliveries.$inferSelect;
export type NewIngestDelivery = typeof ingestDeliveries.$inferInsert;
