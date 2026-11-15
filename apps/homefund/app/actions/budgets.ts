"use server";

import { refresh } from "next/cache";

import { openBudget, reviseBudget } from "@/db/queries/budget-write";
import { archiveBudget, deleteBudget, restoreBudget } from "@/db/queries/budgets";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveBudgetSchema,
  createBudgetSchema,
  deleteBudgetSchema,
  restoreBudgetSchema,
  updateBudgetSchema,
} from "@/lib/validation/budget";

/** Creates a budget (RF-71, RF-73, RF-140); `openBudget` holds the body. */
export const createBudgetAction = authActionClient
  .inputSchema(createBudgetSchema)
  .action(async ({ parsedInput }) => {
    const { budgetId } = await openBudget(parsedInput);

    refresh();
    return { budgetId };
  });

/**
 * Rewrites a budget's editable fields (RF-71, RF-73); `reviseBudget` holds the
 * body. Refused or not, the screen reloads: a form reopened as the refusal asks
 * carries the new stamp.
 */
export const updateBudgetAction = authActionClient
  .inputSchema(updateBudgetSchema)
  .action(async ({ parsedInput }) => {
    try {
      await reviseBudget(parsedInput);
    } finally {
      refresh();
    }
  });

/**
 * Archives a budget (RF-120). The scope is not re-derived: the budget already
 * carries its own, so the update policy decides, and a row it filters reports as
 * no row — the same as a budget that was never there.
 */
export const archiveBudgetAction = authActionClient
  .inputSchema(archiveBudgetSchema)
  .action(async ({ parsedInput: { budgetId } }) => {
    const archived = await archiveBudget({ budgetId });
    if (!archived) throw new ActionError("errors.notFound");

    refresh();
  });

// Restoring passes the same USING that archived it, so it refuses on the same terms.
export const restoreBudgetAction = authActionClient
  .inputSchema(restoreBudgetSchema)
  .action(async ({ parsedInput: { budgetId } }) => {
    const restored = await restoreBudget({ budgetId });
    if (!restored) throw new ActionError("errors.notFound");

    refresh();
  });

// A denied or absent budget reports as no row (RF-73).
export const deleteBudgetAction = authActionClient
  .inputSchema(deleteBudgetSchema)
  .action(async ({ parsedInput: { budgetId } }) => {
    const deleted = await deleteBudget({ budgetId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
