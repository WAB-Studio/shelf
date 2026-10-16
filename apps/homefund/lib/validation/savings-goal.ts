import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import {
  anyCurrencyAmountSchema,
  minorAmountSchema,
} from "@/lib/validation/transaction";

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: "goals.errors.nameRequired" })
  .max(80, { error: "goals.errors.nameTooLong" });

const targetKeys = {
  required: "goals.errors.targetRequired",
  invalid: "goals.errors.targetInvalid",
  tooLarge: "goals.errors.targetTooLarge",
};

const amountKeys = {
  required: "goals.errors.amountRequired",
  invalid: "goals.errors.amountInvalid",
  tooLarge: "goals.errors.amountTooLarge",
};

// A goal's currency is derived from its account, its fund or its owner
// (RF-121), which is a read, so neither field can know its minor unit on its
// own: the shape passes if any offered currency reads it and the refinements
// below run the one right reading.
const targetAmountSchema = anyCurrencyAmountSchema(targetKeys);

const checkTarget = minorAmountSchema(targetKeys);
const checkAmount = minorAmountSchema(amountKeys);

/**
 * The meta and the opening aporte read in the goal's own currency (RF-121). The
 * form runs it against the currency it was handed and the action against the
 * one it reads back — the same rule on both sides (RNF-10).
 */
export function refineGoalAmounts(currency: CurrencyCode) {
  return function refine(
    data: { targetAmount: string; initialContribution?: string | null },
    ctx: z.RefinementCtx,
  ) {
    checkTarget(data.targetAmount, currency, ["targetAmount"], ctx);
    if (data.initialContribution != null) {
      checkAmount(
        data.initialContribution,
        currency,
        ["initialContribution"],
        ctx,
      );
    }
  };
}

// An aporte is set aside in the goal's currency, whatever the movement it may
// earmark settles in (RF-87).
export function refineContributionAmount(currency: CurrencyCode) {
  return function refine(data: { amount: string }, ctx: z.RefinementCtx) {
    checkAmount(data.amount, currency, ["amount"], ctx);
  };
}

// The day the goal aims to be met; it sits in the future by nature, so no
// not-future bound applies (RF-76).
const targetDateSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isCivilDate(value)) {
      ctx.addIssue("goals.errors.targetDateInvalid");
    }
  })
  .nullish();

// The scope follows the account when one is named, else the caller's, resolved
// by the action; it never travels in the payload.
const goalFields = {
  name: nameSchema,
  targetAmount: targetAmountSchema,
  targetDate: targetDateSchema,
  accountId: z.uuid({ error: "goals.errors.accountInvalid" }).nullish(),
};

// An opening virtual aporte seeded at creation (RF-87); optional, same rules.
const initialContributionSchema = anyCurrencyAmountSchema(amountKeys).nullish();

export const createGoalSchema = z.object({
  ...goalFields,
  initialContribution: initialContributionSchema,
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
  ...goalFields,
});

export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

// RF-120: archiving names an existing goal, so its id is all that travels; the
// policy decides the scope, and restore reverses the same field.
export const archiveGoalSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
});

export type ArchiveGoalInput = z.infer<typeof archiveGoalSchema>;

export const restoreGoalSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
});

export type RestoreGoalInput = z.infer<typeof restoreGoalSchema>;

export const deleteGoalSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
});

export type DeleteGoalInput = z.infer<typeof deleteGoalSchema>;

// A typed virtual aporte toward the goal (RF-87); the entry earmarks no
// movement, so the amount alone crosses as a peso string.
export const contributeGoalSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
  amount: anyCurrencyAmountSchema(amountKeys),
});

export type ContributeGoalInput = z.infer<typeof contributeGoalSchema>;

// The undo list names the goal it belongs to; which aportes come back is the
// select policy's call, never the payload's (RF-119).
export const goalContributionsSchema = z.object({
  goalId: z.uuid({ error: "goals.errors.goalInvalid" }),
});

export type GoalContributionsInput = z.infer<typeof goalContributionsSchema>;

export const removeGoalContributionSchema = z.object({
  contributionId: z.uuid({ error: "goals.errors.contributionInvalid" }),
});

export type RemoveGoalContributionInput = z.infer<typeof removeGoalContributionSchema>;
