import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  numeric,
  pgPolicy,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { finances } from "./_schema";
import { accounts } from "./accounts";

// The debt profile a liability account may carry (RF-78): its effective annual rate, its minimum
// payment as a fixed amount XOR a percentage of balance, its credit limit, its statement cut-off and
// payment due days and its aval. It has no scope of its own — the account's scope gates it (RLS below).
export const debtTerms = finances.table(
  "debt_terms",
  {
    accountId: uuid()
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    debtKind: text({ enum: ["revolving", "installment"] }).notNull(),
    // Effective annual fraction, e.g. 0.2800; the monthly conversion is effective, not linear (RF-79).
    annualRate: numeric().notNull(),
    minimumPaymentCents: bigint({ mode: "number" }),
    // A fraction 0..1 of the balance; set instead of minimumPaymentCents, never alongside it.
    minimumPaymentPct: numeric(),
    creditLimitCents: bigint({ mode: "number" }),
    statementCutOffDay: smallint(),
    paymentDueDay: smallint(),
    avalCents: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("debt_terms_kind_valid", sql`${table.debtKind} in ('revolving', 'installment')`),
    check("debt_terms_annual_rate_non_negative", sql`${table.annualRate} >= 0`),
    // The minimum is a fixed amount XOR a percentage, or neither — never both.
    check(
      "debt_terms_minimum_amount_xor_pct",
      sql`num_nonnulls(${table.minimumPaymentCents}, ${table.minimumPaymentPct}) <= 1`,
    ),
    check(
      "debt_terms_minimum_payment_cents_non_negative",
      sql`${table.minimumPaymentCents} is null or ${table.minimumPaymentCents} >= 0`,
    ),
    check(
      "debt_terms_minimum_payment_pct_fraction",
      sql`${table.minimumPaymentPct} is null or (${table.minimumPaymentPct} >= 0 and ${table.minimumPaymentPct} <= 1)`,
    ),
    check(
      "debt_terms_credit_limit_cents_non_negative",
      sql`${table.creditLimitCents} is null or ${table.creditLimitCents} >= 0`,
    ),
    check(
      "debt_terms_aval_cents_non_negative",
      sql`${table.avalCents} is null or ${table.avalCents} >= 0`,
    ),
    check(
      "debt_terms_statement_cut_off_day_valid",
      sql`${table.statementCutOffDay} is null or ${table.statementCutOffDay} between 1 and 31`,
    ),
    check(
      "debt_terms_payment_due_day_valid",
      sql`${table.paymentDueDay} is null or ${table.paymentDueDay} between 1 and 31`,
    ),
    // Readable and writable exactly when the account it profiles is — the scope is the account's.
    pgPolicy("debt_terms_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("debt_terms_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("debt_terms_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("debt_terms_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
    }),
  ],
);

export type DebtTerms = typeof debtTerms.$inferSelect;
export type NewDebtTerms = typeof debtTerms.$inferInsert;
