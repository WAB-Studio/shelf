import { sql } from "drizzle-orm";
import { check, date, index, integer, pgPolicy, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";
import { goals } from "./goals";

// The plan's number for one goal in one calendar month, in the goal's measure
// unit (RP-28). What was reached against it is derived from the facts, never
// stored beside it.
export const monthBudgets = goalsSchema.table(
  "month_budgets",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    goalId: uuid()
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    month: date().notNull(),
    amount: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("month_budgets_user_id_idx").on(t.userId),
    unique("month_budgets_goal_id_month_unique").on(t.goalId, t.month),
    check("month_budgets_month_first_day", sql`${t.month} = date_trunc('month', ${t.month})::date`),
    // Zero is a plan: a month the person means to spend on nothing.
    check("month_budgets_amount_range", sql`${t.amount} between 0 and 1000000`),
    pgPolicy("month_budgets_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    // Under RLS `g` sees only the caller's goals, as in `phases_insert_self`.
    pgPolicy("month_budgets_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and exists (
        select 1 from "goals"."goals" g where g.id = ${t.goalId}
      )`,
    }),
    // The grant narrows this to `amount`; a month moves by delete and insert.
    pgPolicy("month_budgets_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("month_budgets_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type MonthBudget = typeof monthBudgets.$inferSelect;
export type NewMonthBudget = typeof monthBudgets.$inferInsert;
