import { sql } from "drizzle-orm";
import { check, index, pgPolicy, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { transactions } from "./transactions";

// «Está bien» on a movement «Revisar el mes» flagged (RF-155), once per rule. Final: no UPDATE, no
// DELETE — a mark leaves only with its movement, down the cascade. The movement's scope gates it.
export const transactionReviews = finances.table(
  "transaction_reviews",
  {
    id: uuid().primaryKey().defaultRandom(),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    rule: text().notNull(),
    // Set by trigger from `auth.uid()`; no grant lets a caller name it.
    markedBy: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    markedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("transaction_reviews_transaction_rule_unique").on(table.transactionId, table.rule),
    index("transaction_reviews_marked_by_idx").on(table.markedBy),
    check(
      "transaction_reviews_rule",
      sql`${table.rule} in ('above_usual', 'twin', 'from_words', 'reconciliation_gap')`,
    ),
    pgPolicy("transaction_reviews_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_transaction(${table.transactionId}))`,
    }),
    pgPolicy("transaction_reviews_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_transaction_row(${table.transactionId}))`,
    }),
  ],
);

export type TransactionReview = typeof transactionReviews.$inferSelect;
