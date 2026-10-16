import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import {
  anyCurrencyAmountSchema,
  minorAmountSchema,
} from "@/lib/validation/transaction";

// The window a budget's limit is spent against (RF-71); the form and the DB
// enum read the same list.
export const BUDGET_PERIODS = ["monthly", "weekly", "yearly"] as const;

const limitKeys = {
  required: "budgets.errors.limitRequired",
  invalid: "budgets.errors.limitInvalid",
  tooLarge: "budgets.errors.limitTooLarge",
};

// The field on its own cannot know its minor unit: a budget's currency is
// derived from its account, its fund or its owner (RF-121), which is a read.
// So the shape passes if any offered currency reads it, and the one right
// reading is `refineBudgetLimit`'s, run by whoever knows the currency.
const limitSchema = anyCurrencyAmountSchema(limitKeys);

const checkLimit = minorAmountSchema(limitKeys);

/**
 * The limit read in the currency the budget derives (RF-121). The form runs it
 * against the currency it was handed and the action against the one it reads
 * back — the same rule on both sides, never the payload's word for it (RNF-10).
 */
export function refineBudgetLimit(currency: CurrencyCode) {
  return function refine(data: { limit: string }, ctx: z.RefinementCtx) {
    checkLimit(data.limit, currency, ["limit"], ctx);
  };
}

// A whole percentage of the limit at which the budget warns (RF-71); one and a
// hundred are both allowed, nothing outside.
const thresholdPctSchema = z
  .number({ error: "budgets.errors.thresholdInvalid" })
  .int({ error: "budgets.errors.thresholdInvalid" })
  .min(1, { error: "budgets.errors.thresholdInvalid" })
  .max(100, { error: "budgets.errors.thresholdInvalid" });

// A name of nothing but spaces would title the card with a blank instead of
// letting it fall back to the category's own name, so it lands as null.
const nameSchema = z
  .string()
  .trim()
  .max(80, { error: "budgets.errors.nameTooLong" })
  .nullish()
  .transform((value) => value?.trim() || null);

// The account and label only narrow the spend the limit is measured against;
// leaving either off measures the category's whole spend.
const budgetFields = {
  accountId: z.uuid({ error: "budgets.errors.accountInvalid" }).nullish(),
  labelId: z.uuid({ error: "budgets.errors.labelInvalid" }).nullish(),
  period: z.enum(BUDGET_PERIODS, { error: "budgets.errors.periodInvalid" }),
  limit: limitSchema,
  thresholdPct: thresholdPctSchema,
  name: nameSchema,
};

// The scope follows the category, resolved by the action and checked by the
// `assert_budget_scope` trigger, so it never travels in the payload.
export const createBudgetSchema = z.object({
  categoryId: z.uuid({ error: "budgets.errors.categoryInvalid" }),
  ...budgetFields,
});

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

// The category is immutable, so an edit drops it and carries the budget's id
// instead.
export const updateBudgetSchema = z.object({
  budgetId: z.uuid({ error: "budgets.errors.budgetInvalid" }),
  ...budgetFields,
});

export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

// RF-120: archiving names an existing budget, so its id is all that travels;
// the policy decides the scope, and restore reverses the same field.
export const archiveBudgetSchema = z.object({
  budgetId: z.uuid({ error: "budgets.errors.budgetInvalid" }),
});

export type ArchiveBudgetInput = z.infer<typeof archiveBudgetSchema>;

export const restoreBudgetSchema = z.object({
  budgetId: z.uuid({ error: "budgets.errors.budgetInvalid" }),
});

export type RestoreBudgetInput = z.infer<typeof restoreBudgetSchema>;

export const deleteBudgetSchema = z.object({
  budgetId: z.uuid({ error: "budgets.errors.budgetInvalid" }),
});

export type DeleteBudgetInput = z.infer<typeof deleteBudgetSchema>;
