"use server";

import { refresh } from "next/cache";

import { z } from "zod";

import {
  archiveBudget,
  createBudget,
  deleteBudget,
  resolveBudgetCurrency,
  restoreBudget,
  updateBudget,
} from "@/db/queries/budgets";
import { getUserGroup } from "@/db/queries/groups";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveBudgetSchema,
  createBudgetSchema,
  deleteBudgetSchema,
  refineBudgetLimit,
  restoreBudgetSchema,
  updateBudgetSchema,
} from "@/lib/validation/budget";

/**
 * The limit read in the currency the budget derives, never in the one the
 * payload implies (RF-121). The refinement is the very one the form runs, so a
 * limit the account's currency cannot hold is refused in the same words on both
 * sides (RNF-10); past it, a null parse can only be a schema that let something
 * through, so it is `errors.unexpected` and not a field message.
 */
function toMinor(amount: string, currency: CurrencyCode): number {
  const verdict = z
    .custom<{ limit: string }>()
    .superRefine(refineBudgetLimit(currency))
    .safeParse({ limit: amount });

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// The `assert_budget_scope` trigger raises 23514 when the account, label or
// category do not share the budget's scope; a missing category trips its
// foreign key; a denied write reads the same as a budget that was never there.
function mapBudgetError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("budgets.errors.scopeViolation");
  if (code === "23503") throw new ActionError("errors.categoryInUse");
  throw error;
}

/**
 * Creates a budget (RF-71, RF-73). The scope is the caller's group when they
 * belong to one, otherwise their personal set; the account, label and category
 * must all share it, which the trigger checks.
 */
export const createBudgetAction = authActionClient
  .inputSchema(createBudgetSchema)
  .action(async ({ parsedInput: { limit, accountId, labelId, name, ...budget }, ctx }) => {
    // The currency and the scope ride one fan-out: neither read waits on the other.
    const [currency, group] = await Promise.all([
      resolveBudgetCurrency({ accountId: accountId ?? null }),
      getUserGroup(),
    ]);
    const limitCents = toMinor(limit, currency);

    const scope = group
      ? { ownerUserId: null, groupId: group.id }
      : { ownerUserId: ctx.user.id, groupId: null };

    let budgetId: string;
    try {
      ({ budgetId } = await createBudget({
        ...budget,
        ...scope,
        accountId: accountId ?? null,
        labelId: labelId ?? null,
        name: name ?? null,
        limitCents,
      }));
    } catch (error) {
      mapBudgetError(error);
    }

    refresh();
    return { budgetId };
  });

/**
 * Rewrites a budget's editable fields (RF-71, RF-73). The category and the
 * scope are immutable and never travel in the payload, so a denied edit reports
 * as no row, the same as a budget that was never there.
 */
export const updateBudgetAction = authActionClient
  .inputSchema(updateBudgetSchema)
  .action(async ({ parsedInput: { limit, accountId, labelId, name, ...budget } }) => {
    const currency = await resolveBudgetCurrency({
      budgetId: budget.budgetId,
      accountId: accountId ?? null,
    });
    const limitCents = toMinor(limit, currency);

    let updated: boolean;
    try {
      updated = await updateBudget({
        ...budget,
        accountId: accountId ?? null,
        labelId: labelId ?? null,
        name: name ?? null,
        limitCents,
      });
    } catch (error) {
      mapBudgetError(error);
    }

    if (!updated) throw new ActionError("errors.notFound");

    refresh();
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
