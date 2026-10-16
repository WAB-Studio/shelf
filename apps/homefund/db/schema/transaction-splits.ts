import { sql } from "drizzle-orm";
import { bigint, check, index, uuid } from "drizzle-orm/pg-core";

import { finances } from "./_schema";
import { categories } from "./categories";
import { transactions } from "./transactions";

// An income or expense splits into one or more (category, amount) rows summing to its amount (RF-69).
// A transfer has no splits and no category.
export const transactionSplits = finances.table(
  "transaction_splits",
  {
    id: uuid().primaryKey().defaultRandom(),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountCents: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    check("transaction_splits_amount_positive", sql`${table.amountCents} > 0`),
    index("transaction_splits_transaction_id_idx").on(table.transactionId),
    index("transaction_splits_category_id_idx").on(table.categoryId),
  ],
);

export type TransactionSplit = typeof transactionSplits.$inferSelect;
export type NewTransactionSplit = typeof transactionSplits.$inferInsert;
