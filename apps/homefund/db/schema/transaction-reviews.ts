import { sql } from "drizzle-orm";
import { check, index, pgPolicy, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { REVIEW_RULES } from "@/lib/month-review-rules";

import { finances } from "./_schema";
import { appUsers } from "./app-users";
import { transactions } from "./transactions";

// «Está bien» on a movement «Revisar el mes» flagged (RF-155), once per rule. No UPDATE; «Deshacer»
// deletes it (RF-163) and the cascade drops it with its movement. The movement's scope gates both.
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
      sql`${table.rule} in (${sql.raw(REVIEW_RULES.map((rule) => `'${rule}'`).join(", "))})`,
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
    pgPolicy("transaction_reviews_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_transaction_row(${table.transactionId}))`,
    }),
  ],
);

export type TransactionReview = typeof transactionReviews.$inferSelect;
