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
import { accounts } from "./accounts";
import { appUsers } from "./app-users";

// What a user's completions have taught about one counterparty (RF-133, RF-135). Mirrors
// `ingest-merchants.ts` field for field: `category` becomes `account`, and `side` joins the key
// because the same span can fill either leg of a movement in different rows — a pattern that would
// teach both sides is ambiguous by definition, not two memories sharing one row. Two consecutive
// agreeing completions make it `trusted`; a completion naming a different account makes it
// `ambiguous`, which no later agreement undoes. `pattern_key` is `counterpartyPatternKey` from
// `lib/ingest/counterparty-pattern.ts`, a normalised span of a statement row's description — a
// different source and a different function than the SMS fingerprint `ingest_merchants` learns from.
//
// `private.remember_counterparty` is the sole writer: `authenticated` holds neither INSERT nor
// UPDATE, so the transition cannot be forged from a client. SELECT and DELETE stay with the person.
export const ingestCounterparties = finances.table(
  "ingest_counterparties",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Resolved from auth.uid() inside the transition function, never read from its arguments.
    ownerUserId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    // The normalised description span `counterpartyPatternKey` produced; the label is the same span
    // verbatim, kept for the screen the way `ingest_merchants.merchant_label` is.
    patternKey: text().notNull(),
    patternLabel: text().notNull(),
    // Which leg of the movement this pattern fills. Part of the key, not a payload: a span that would
    // fill both sides in different rows is two memories, not one that could contradict itself.
    side: text({ enum: ["from", "to"] }).notNull(),
    state: text({ enum: ["learning", "trusted", "ambiguous"] })
      .notNull()
      .default("learning"),
    // The account the current run of completions is on; the streak counts that run.
    candidateAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    streak: smallint().notNull().default(0),
    // Set null, and a BEFORE UPDATE trigger takes the row back to `learning` in the same statement,
    // so the account's deletion (RF-63) keeps the rule and forgets only its target.
    trustedAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ingest_counterparties_state_valid",
      sql`${table.state} in ('learning', 'trusted', 'ambiguous')`,
    ),
    check("ingest_counterparties_side_valid", sql`${table.side} in ('from', 'to')`),
    // Trusted and having a trusted account are the same fact, so neither can drift from the other.
    check(
      "ingest_counterparties_trusted_account_matches_state",
      sql`(${table.state} = 'trusted') = (${table.trustedAccountId} is not null)`,
    ),
    // Two consecutive agreeing completions is the whole rule, so the count never runs past it (RF-135).
    check("ingest_counterparties_streak_range", sql`${table.streak} between 0 and 2`),
    check(
      "ingest_counterparties_pattern_key_length",
      sql`length(${table.patternKey}) between 1 and 120`,
    ),
    check(
      "ingest_counterparties_pattern_label_length",
      sql`length(${table.patternLabel}) between 1 and 120`,
    ),
    // One memory per pattern per side per user; the transition function locks exactly this key.
    uniqueIndex("ingest_counterparties_owner_pattern_side_unique").on(
      table.ownerUserId,
      table.patternKey,
      table.side,
    ),
    // Parent deletes check these foreign keys; without an index each one scans this table.
    index("ingest_counterparties_candidate_account_id_idx")
      .on(table.candidateAccountId)
      .where(sql`${table.candidateAccountId} is not null`),
    index("ingest_counterparties_trusted_account_id_idx")
      .on(table.trustedAccountId)
      .where(sql`${table.trustedAccountId} is not null`),
    pgPolicy("ingest_counterparties_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
    // Forgetting is the only way out of `ambiguous` (RF-135).
    pgPolicy("ingest_counterparties_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${table.ownerUserId} = ${authUid}`,
    }),
  ],
);

export type IngestCounterparty = typeof ingestCounterparties.$inferSelect;
export type NewIngestCounterparty = typeof ingestCounterparties.$inferInsert;
