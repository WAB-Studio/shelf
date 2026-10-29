import { sql } from "drizzle-orm";
import { check, pgPolicy, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";

// What a user has decided about a message shape (RF-92). A `rejected` shape arrives already rejected and
// never waits for review; anything else waits. The decision only chooses land-versus-silence — no shape
// ever records a movement. The sample keeps one message of that shape, so the decision stays readable.
export const ingestShapes = finances.table(
  "ingest_shapes",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Owner is stamped from auth.uid() by a BEFORE INSERT trigger; a shape memory is per user.
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    // SHA-256 hex of the masked message; the same key the delivery carries.
    shapeHash: text().notNull(),
    decision: text({ enum: ["approved", "rejected"] }).notNull(),
    sampleText: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("ingest_shapes_decision_valid", sql`${table.decision} in ('approved', 'rejected')`),
    check("ingest_shapes_shape_hash_length", sql`length(${table.shapeHash}) = 64`),
    check("ingest_shapes_sample_text_length", sql`length(${table.sampleText}) between 1 and 500`),
    // One decision per shape per user; the insert trigger reads exactly this key.
    uniqueIndex("ingest_shapes_owner_shape_hash_unique").on(table.ownerUserId, table.shapeHash),
    pgPolicy("ingest_shapes_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("ingest_shapes_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("ingest_shapes_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
      withCheck: sql`${table.ownerUserId} = ${authUid}`,
    }),
    pgPolicy("ingest_shapes_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
  ],
);

export type IngestShape = typeof ingestShapes.$inferSelect;
export type NewIngestShape = typeof ingestShapes.$inferInsert;
