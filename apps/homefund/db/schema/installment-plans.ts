import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
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

// A fixed-installment or BNPL plan over an existing liability (RF-81): principal, count, frequency,
// interest, down payment, aval, start date and merchant. It schedules the balance into dated lines and
// never adds to total owed. It has no scope — the account's scope gates it (RLS below).
export const installmentPlans = finances.table(
  "installment_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    description: text(),
    principalCents: bigint({ mode: "number" }).notNull(),
    nInstallments: smallint().notNull(),
    frequency: text({ enum: ["monthly", "fortnightly"] }).notNull(),
    interestRate: numeric(),
    downPaymentCents: bigint({ mode: "number" }),
    avalCents: bigint({ mode: "number" }),
    // Date-only, interpreted in America/Bogota (RNF-06): a YYYY-MM-DD string end to end, never a JS Date.
    startDate: date({ mode: "string" }).notNull(),
    merchant: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("installment_plans_principal_positive", sql`${table.principalCents} > 0`),
    check("installment_plans_n_installments_positive", sql`${table.nInstallments} > 0`),
    check(
      "installment_plans_frequency_valid",
      sql`${table.frequency} in ('monthly', 'fortnightly')`,
    ),
    check(
      "installment_plans_interest_rate_non_negative",
      sql`${table.interestRate} is null or ${table.interestRate} >= 0`,
    ),
    check(
      "installment_plans_down_payment_cents_non_negative",
      sql`${table.downPaymentCents} is null or ${table.downPaymentCents} >= 0`,
    ),
    check(
      "installment_plans_aval_cents_non_negative",
      sql`${table.avalCents} is null or ${table.avalCents} >= 0`,
    ),
    check(
      "installment_plans_description_length",
      sql`length(${table.description}) <= 200`,
    ),
    check("installment_plans_merchant_length", sql`length(${table.merchant}) <= 120`),
    index("installment_plans_account_id_idx").on(table.accountId),
    // Readable and writable exactly when the account it schedules is — the scope is the account's.
    pgPolicy("installment_plans_select", {
      for: "select",
      to: authenticatedRole,
      using: sql`(select private.can_read_account(${table.accountId}))`,
    }),
    pgPolicy("installment_plans_insert", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("installment_plans_update", {
      for: "update",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
      withCheck: sql`(select private.can_write_account(${table.accountId}))`,
    }),
    pgPolicy("installment_plans_delete", {
      for: "delete",
      to: authenticatedRole,
      using: sql`(select private.can_write_account(${table.accountId}))`,
    }),
  ],
);

export type InstallmentPlan = typeof installmentPlans.$inferSelect;
