import { z } from "zod";

import { BASE_CURRENCY } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import {
  accountRefSchema,
  anyCurrencyAmountSchema,
  minorAmountSchema,
  type SettlementCurrencies,
} from "@/lib/validation/transaction";

const amountKeys = {
  required: "recurringRules.errors.amountRequired",
  invalid: "recurringRules.errors.amountInvalid",
  tooLarge: "recurringRules.errors.amountTooLarge",
};

// The field cannot know its minor unit until the account is read, so the shape
// passes if any offered currency reads it and `refineRuleAmount` runs the one
// right reading (RF-121).
const amountSchema = anyCurrencyAmountSchema(amountKeys);

const checkAmount = minorAmountSchema(amountKeys);

/**
 * What the rule settles in: a rule names exactly one account, so one side
 * answers and the other is null — the currency the movement it generates is
 * booked in.
 */
export function recurringRuleCurrency(settlement: SettlementCurrencies): string {
  return settlement.from ?? settlement.to ?? BASE_CURRENCY;
}

/**
 * The amount read in that account's currency (RF-121). The form runs it against
 * the currency it was handed and the action against the one it reads back — the
 * same rule on both sides (RNF-10).
 */
export function refineRuleAmount(settlement: SettlementCurrencies) {
  return function refine(data: { amount: string }, ctx: z.RefinementCtx) {
    checkAmount(data.amount, recurringRuleCurrency(settlement), ["amount"], ctx);
  };
}

// The date the next run falls due; a rule runs into the future, so no not-future
// bound applies (RF-29).
const nextRunOnSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("recurringRules.errors.nextRunOnRequired");
    return;
  }

  if (!isCivilDate(value)) {
    ctx.addIssue("recurringRules.errors.nextRunOnInvalid");
  }
});

// When the rule stops generating; optional, and never before the next run it caps (RF-32).
const endsOnSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isCivilDate(value)) {
      ctx.addIssue("recurringRules.errors.endsOnInvalid");
    }
  })
  .nullish();

const descriptionSchema = z
  .string()
  .trim()
  .max(200, { error: "recurringRules.errors.descriptionTooLong" })
  .nullish();

// Every N periods of the frequency, at least one; the form may omit it, so it defaults.
const intervalNSchema = z
  .number({ error: "recurringRules.errors.intervalInvalid" })
  .int({ error: "recurringRules.errors.intervalInvalid" })
  .min(1, { error: "recurringRules.errors.intervalInvalid" })
  .default(1);

// The month-anchor day for monthly and yearly; weekly carries none.
const dayOfMonthSchema = z
  .number({ error: "recurringRules.errors.dayOfMonthInvalid" })
  .int({ error: "recurringRules.errors.dayOfMonthInvalid" })
  .min(1, { error: "recurringRules.errors.dayOfMonthInvalid" })
  .max(31, { error: "recurringRules.errors.dayOfMonthInvalid" })
  .nullish();

// A rule is always one-sided: a destination means income, a source means expense,
// never both and never neither, so the scope and direction derive from the one
// account (RF-29). Unlike a movement, a transfer is never a rule.
function requireExactlyOneAccount(
  data: { fromAccountId: string | null; toAccountId: string | null },
  ctx: z.RefinementCtx,
) {
  const count = Number(data.fromAccountId !== null) + Number(data.toAccountId !== null);
  if (count !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "recurringRules.errors.exactlyOneAccount",
      path: ["fromAccountId"],
    });
  }
}

// Monthly and yearly anchor a day of the month; weekly advances from `next_run_on`
// and ignores any day it was given.
function requireDayOfMonthByFrequency(
  data: { frequency: string; dayOfMonth?: number | null },
  ctx: z.RefinementCtx,
) {
  if (data.frequency === "weekly") return;
  if (data.dayOfMonth == null) {
    ctx.addIssue({
      code: "custom",
      message: "recurringRules.errors.dayOfMonthRequired",
      path: ["dayOfMonth"],
    });
  }
}

// An end date that falls before the next run would stop the rule before it ever runs.
function requireEndsOnAfterNextRun(
  data: { nextRunOn: string; endsOn?: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.endsOn != null && data.endsOn < data.nextRunOn) {
    ctx.addIssue({
      code: "custom",
      message: "recurringRules.errors.endsOnBeforeNextRun",
      path: ["endsOn"],
    });
  }
}

// The scope and `created_by` follow the one account, set by the
// `set_recurring_rule_scope` trigger and never sent; `is_active` starts true and
// `next_run_on` advances on generation, so neither the pause flag nor the cursor
// travels through the create/update payload.
const recurringRuleFields = {
  fromAccountId: accountRefSchema,
  toAccountId: accountRefSchema,
  amount: amountSchema,
  categoryId: z.uuid({ error: "recurringRules.errors.categoryInvalid" }),
  description: descriptionSchema,
  frequency: z.enum(["monthly", "weekly", "yearly"], {
    error: "recurringRules.errors.frequencyInvalid",
  }),
  intervalN: intervalNSchema,
  dayOfMonth: dayOfMonthSchema,
  nextRunOn: nextRunOnSchema,
  endsOn: endsOnSchema,
};

export const createRecurringRuleSchema = z
  .object(recurringRuleFields)
  .superRefine(requireExactlyOneAccount)
  .superRefine(requireDayOfMonthByFrequency)
  .superRefine(requireEndsOnAfterNextRun);

export type CreateRecurringRuleInput = z.infer<typeof createRecurringRuleSchema>;

export const updateRecurringRuleSchema = z
  .object({
    id: z.uuid({ error: "recurringRules.errors.ruleInvalid" }),
    ...recurringRuleFields,
  })
  .superRefine(requireExactlyOneAccount)
  .superRefine(requireDayOfMonthByFrequency)
  .superRefine(requireEndsOnAfterNextRun);

export type UpdateRecurringRuleInput = z.infer<typeof updateRecurringRuleSchema>;

// Pausing keeps the rule and its history; the generator skips a paused rule (RF-32).
export const pauseRecurringRuleSchema = z.object({
  id: z.uuid({ error: "recurringRules.errors.ruleInvalid" }),
});

export type PauseRecurringRuleInput = z.infer<typeof pauseRecurringRuleSchema>;

export const resumeRecurringRuleSchema = z.object({
  id: z.uuid({ error: "recurringRules.errors.ruleInvalid" }),
});

export type ResumeRecurringRuleInput = z.infer<typeof resumeRecurringRuleSchema>;

// Clearing the end date sends null, so it lets the rule run on (RF-32).
export const setRecurringRuleEndDateSchema = z.object({
  id: z.uuid({ error: "recurringRules.errors.ruleInvalid" }),
  endsOn: endsOnSchema,
});

export type SetRecurringRuleEndDateInput = z.infer<typeof setRecurringRuleEndDateSchema>;

export const deleteRecurringRuleSchema = z.object({
  id: z.uuid({ error: "recurringRules.errors.ruleInvalid" }),
});

export type DeleteRecurringRuleInput = z.infer<typeof deleteRecurringRuleSchema>;

// Confirming a generated movement leaves nothing to change but its reviewed stamp (RF-31).
export const markMovementReviewedSchema = z.object({
  transactionId: z.uuid({ error: "recurringRules.errors.transactionInvalid" }),
});

export type MarkMovementReviewedInput = z.infer<typeof markMovementReviewedSchema>;
