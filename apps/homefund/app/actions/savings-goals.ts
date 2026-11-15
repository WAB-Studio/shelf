"use server";

import { refresh } from "next/cache";

import { contributeToGoal, openGoal, reviseGoal } from "@/db/queries/goal-write";
import {
  archiveGoal,
  deleteGoal,
  listGoalContributions,
  removeGoalContribution,
  restoreGoal,
  type GoalContributionRow,
} from "@/db/queries/savings-goals";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveGoalSchema,
  contributeGoalSchema,
  createGoalSchema,
  deleteGoalSchema,
  goalContributionsSchema,
  removeGoalContributionSchema,
  restoreGoalSchema,
  updateGoalSchema,
} from "@/lib/validation/savings-goal";

/**
 * Creates a savings goal (RF-76); `openGoal` holds the body, and the owner it
 * files a personal goal under is the session's.
 */
export const createGoalAction = authActionClient
  .inputSchema(createGoalSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { goalId } = await openGoal(parsedInput, ctx.user.id);

    refresh();
    return { goalId };
  });

/**
 * Rewrites a goal's editable fields (RF-76); `reviseGoal` holds the body.
 * Refused or not, the screen reloads: a form reopened as the refusal asks
 * carries the new stamp.
 */
export const updateGoalAction = authActionClient
  .inputSchema(updateGoalSchema)
  .action(async ({ parsedInput }) => {
    try {
      await reviseGoal(parsedInput);
    } finally {
      refresh();
    }
  });

/**
 * Archives a savings goal (RF-120). The scope is not re-derived: the goal already
 * carries its own, so the update policy decides, and a row it filters reports as
 * no row — the same as a goal that was never there.
 */
export const archiveGoalAction = authActionClient
  .inputSchema(archiveGoalSchema)
  .action(async ({ parsedInput: { goalId } }) => {
    const archived = await archiveGoal({ goalId });
    if (!archived) throw new ActionError("errors.notFound");

    refresh();
  });

// Restoring passes the same USING that archived it, so it refuses on the same terms.
export const restoreGoalAction = authActionClient
  .inputSchema(restoreGoalSchema)
  .action(async ({ parsedInput: { goalId } }) => {
    const restored = await restoreGoal({ goalId });
    if (!restored) throw new ActionError("errors.notFound");

    refresh();
  });

export const deleteGoalAction = authActionClient
  .inputSchema(deleteGoalSchema)
  .action(async ({ parsedInput: { goalId } }) => {
    const deleted = await deleteGoal({ goalId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });

/** Adds a typed virtual aporte toward a goal (RF-87); `contributeToGoal` holds the body. */
export const contributeGoalAction = authActionClient
  .inputSchema(contributeGoalSchema)
  .action(async ({ parsedInput }) => {
    const { contributionId } = await contributeToGoal(parsedInput);

    refresh();
    return { contributionId };
  });

/**
 * One goal's aportes for the undo list (RF-119). A read: it writes nothing and
 * refreshes nothing, and the select policy — not the goal id — decides which rows
 * come back. The list is fetched when a person opens it, so a screen full of
 * goals costs no round trip for the ones nobody asks about.
 */
export const listGoalContributionsAction = authActionClient
  .inputSchema(goalContributionsSchema)
  .action(async ({ parsedInput: { goalId } }): Promise<GoalContributionRow[]> => {
    return listGoalContributions(goalId);
  });

// A false row count is a contribution that was denied or already gone (RF-87).
export const removeGoalContributionAction = authActionClient
  .inputSchema(removeGoalContributionSchema)
  .action(async ({ parsedInput: { contributionId } }) => {
    const removed = await removeGoalContribution({ contributionId });
    if (!removed) throw new ActionError("errors.notFound");

    refresh();
  });
