"use server";

import { refresh } from "next/cache";

import {
  openRecurringRule,
  pauseRecurringRule,
  resumeRecurringRule,
  reviseRecurringRule,
} from "@/db/queries/recurring-rule-write";
import { deleteRecurringRule, markTransactionReviewed } from "@/db/queries/recurring-rules";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  createRecurringRuleSchema,
  deleteRecurringRuleSchema,
  markMovementReviewedSchema,
  pauseRecurringRuleSchema,
  resumeRecurringRuleSchema,
  updateRecurringRuleSchema,
} from "@/lib/validation/recurring-rule";

/** Creates a repeating income or expense (RF-29); `openRecurringRule` holds the body. */
export const createRecurringRuleAction = authActionClient
  .inputSchema(createRecurringRuleSchema)
  .action(async ({ parsedInput }) => {
    const { recurringRuleId } = await openRecurringRule(parsedInput);

    refresh();
    return { recurringRuleId };
  });

/** Rewrites a rule's definition (RF-29); `reviseRecurringRule` holds the body. */
export const updateRecurringRuleAction = authActionClient
  .inputSchema(updateRecurringRuleSchema)
  .action(async ({ parsedInput }) => {
    await reviseRecurringRule(parsedInput);

    refresh();
  });

export const deleteRecurringRuleAction = authActionClient
  .inputSchema(deleteRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    const deleted = await deleteRecurringRule({ id });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });

export const pauseRecurringRuleAction = authActionClient
  .inputSchema(pauseRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    await pauseRecurringRule(id);

    refresh();
  });

export const resumeRecurringRuleAction = authActionClient
  .inputSchema(resumeRecurringRuleSchema)
  .action(async ({ parsedInput: { id } }) => {
    await resumeRecurringRule(id);

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
