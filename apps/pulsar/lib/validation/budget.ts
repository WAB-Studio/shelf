import { z } from "zod";

import { lastMonthOf, monthOf } from "@/lib/plan/months";

// The month the URL and the sheet speak in, never a day: `/meses/2026-10`.
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const goalId = z.uuid({ error: "month.errors.invalid" });
const month = z
  .string({ error: "month.errors.monthInvalid" })
  .regex(MONTH_PATTERN, { error: "month.errors.monthInvalid" });

export const setMonthBudgetSchema = z.object({
  goalId,
  month,
  // Zero is a plan, the way `month_budgets_amount_range` lets it be.
  amount: z
    .number({ error: "month.errors.amountInvalid" })
    .int({ error: "month.errors.amountInvalid" })
    .min(0, { error: "month.errors.amountInvalid" })
    .max(1_000_000, { error: "month.errors.amountInvalid" }),
});

export type SetMonthBudgetInput = z.infer<typeof setMonthBudgetSchema>;

export const removeMonthBudgetSchema = z.object({ goalId, month });

export type RemoveMonthBudgetInput = z.infer<typeof removeMonthBudgetSchema>;

// "2026-10" as the column stores it, the month's first day.
export function monthStart(month: string): string {
  return `${month}-01`;
}

// The horizon is the first day after the goal, so the last month is the last
// day's, not the horizon's: a horizon on the 1st plans nothing in its month.
export function monthOutsideSpan({
  month,
  openedOn,
  horizon,
  today,
}: {
  month: string;
  openedOn: string;
  horizon: string | null;
  today?: string;
}): boolean {
  const start = monthStart(month);
  return start < monthOf(openedOn) || start > lastMonthOf(openedOn, horizon, today);
}
