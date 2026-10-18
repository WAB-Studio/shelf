"use server";

import { refresh } from "next/cache";

import { z } from "zod";

import {
  categoryFitsRuleAccount,
  createRecurringRule,
  deleteRecurringRule,
  markTransactionReviewed,
  setRecurringRuleActive,
  updateRecurringRule,
} from "@/db/queries/recurring-rules";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  createRecurringRuleSchema,
  deleteRecurringRuleSchema,
  markMovementReviewedSchema,
  pauseRecurringRuleSchema,
  refineRuleAmount,
  resumeRecurringRuleSchema,
  updateRecurringRuleSchema,
} from "@/lib/validation/recurring-rule";

/**
 * The amount read in the currency the rule's one account settles in, never in
 * the one the payload implies (RF-121): the currency comes from the account, in
 * one round trip, and the refinement that reads the string against it is the
 * very one the form runs (RNF-10). Past it, a null parse can only be a schema
 * that let something through, so it is `errors.unexpected`.
 */
async function toMinor(
  amount: string,
  accounts: { fromAccountId: string | null; toAccountId: string | null },
): Promise<number> {
  const settlement = await getSettlementCurrencies(accounts);
  const verdict = z
    .custom<{ amount: string }>()
    .superRefine(refineRuleAmount(settlement))
    .safeParse({ amount });

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// Weekly advances from `next_run_on` and carries no day anchor; the DB check
// rejects a stray day, so it is dropped before the write.
function dayForFrequency(frequency: string, dayOfMonth?: number | null): number | null {
  return frequency === "weekly" ? null : (dayOfMonth ?? null);
}

// The scope trigger raises 23514 when the account disagrees on scope; a denied
// write reads as an absent rule, and a deleted account lands there too — the
// policy names the accounts, so it refuses before any foreign key. The category is
// guarded by `assertCategoryFits` before the write, so 23503 is the one left: a
// category picked from the list and deleted before the rule was saved.
function mapRecurringRuleError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("recurringRules.errors.scopeViolation");
  // RR001: the new next run falls on or before a period the rule already booked.
  if (code === "RR001") throw new ActionError("recurringRules.errors.nextRunOnBooked");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

// The generator inserts the rule's split under the split trigger, which refuses a
// category of another scope or kind; checking here keeps such a rule from ever
// being stored.
async function assertCategoryFits(rule: {
  categoryId: string;
  fromAccountId: string | null;
  toAccountId: string | null;
}): Promise<void> {
  if (!(await categoryFitsRuleAccount(rule))) {
    throw new ActionError("recurringRules.errors.scopeViolation");
  }
}

/**
 * Creates a repeating income or expense (RF-29). The scope and `created_by` follow
 * the one account, set by the trigger and never sent; `is_active` starts true and
 * the generator advances `next_run_on` from here.
 */
export const createRecurringRuleAction = authActionClient
  .inputSchema(createRecurringRuleSchema)
  .action(async ({ parsedInput: { amount, frequency, dayOfMonth, description, endsOn, ...rule } }) => {
    const [amountCents] = await Promise.all([toMinor(amount, rule), assertCategoryFits(rule)]);

    let recurringRuleId: string;
    try {
      ({ recurringRuleId } = await createRecurringRule({
        ...rule,
        amountCents,
        frequency,
        dayOfMonth: dayForFrequency(frequency, dayOfMonth),
        description: description ?? null,
        endsOn: endsOn ?? null,
      }));
    } catch (error) {
      mapRecurringRuleError(error);
    }

    refresh();
    return { recurringRuleId };
  });

/**
 * Rewrites a rule's definition (RF-29). `is_active` is the pause/resume path's to
 * write. `next_run_on` travels, and the database refuses one at or before the last
 * period the rule booked. A denied edit reports as no row.
 */
export const updateRecurringRuleAction = authActionClient
  .inputSchema(updateRecurringRuleSchema)
  .action(async ({ parsedInput: { amount, frequency, dayOfMonth, description, endsOn, ...rule } }) => {
    const [amountCents] = await Promise.all([toMinor(amount, rule), assertCategoryFits(rule)]);

    let updated: Awaited<ReturnType<typeof updateRecurringRule>>;
    try {
      updated = await updateRecurringRule({
        ...rule,
        amountCents,
        frequency,
        dayOfMonth: dayForFrequency(frequency, dayOfMonth),
        description: description ?? null,
        endsOn: endsOn ?? null,
      });
    } catch (error) {
      mapRecurringRuleError(error);
    }

    if (updated === "stale") throw new ActionError("errors.stale");
    if (updated === "missing") throw new ActionError("errors.notFound");

    refresh();
  });

export const deleteRecurringRuleAction = authActionClient
  .inputSchema(deleteRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    const deleted = await deleteRecurringRule({ id });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });

// Pausing keeps the rule and its history; the generator skips it while `is_active`
// is false (RF-32). A false row count is a denied or absent rule.
export const pauseRecurringRuleAction = authActionClient
  .inputSchema(pauseRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    const paused = await setRecurringRuleActive({ id, isActive: false });
    if (!paused) throw new ActionError("errors.notFound");

    refresh();
  });

export const resumeRecurringRuleAction = authActionClient
  .inputSchema(resumeRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    const resumed = await setRecurringRuleActive({ id, isActive: true });
    if (!resumed) throw new ActionError("errors.notFound");

    refresh();
  });

/**
 * Confirms a generated movement without touching its amount (RF-31). Correcting a
 * generated amount instead goes through the transaction edit action, which stamps
 * the review as part of that same write. The guard only claims a generated,
 * unreviewed row, so a manual movement is never stamped.
 */
export const markMovementReviewedAction = authActionClient
  .inputSchema(markMovementReviewedSchema)
  .action(async ({ parsedInput: { transactionId } }) => {
    const reviewed = await markTransactionReviewed({ transactionId });
    if (!reviewed) throw new ActionError("errors.notFound");

    refresh();
  });
