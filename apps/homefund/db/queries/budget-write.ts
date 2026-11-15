import "server-only";

import { z } from "zod";

import {
  createBudget,
  resolveBudgetCurrency,
  resolveBudgetPlace,
  updateBudget,
} from "@/db/queries/budgets";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import {
  type CreateBudgetInput,
  refineBudgetLimit,
  type UpdateBudgetInput,
} from "@/lib/validation/budget";

// The writes behind the budget forms' actions and behind `/mcp`: each takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

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
 * Creates a budget (RF-71, RF-73, RF-140). It is filed in the place of the
 * account it names, else of its category; the account, label and category must
 * all share it, which the trigger checks.
 */
export async function openBudget({
  limit,
  accountId,
  labelId,
  name,
  ...budget
}: CreateBudgetInput): Promise<{ budgetId: string }> {
  const place = await resolveBudgetPlace({
    categoryId: budget.categoryId,
    accountId: accountId ?? null,
  });
  if (!place) throw new ActionError("errors.notFound");
  const limitCents = toMinor(limit, place.currency as CurrencyCode);

  const scope = { ownerUserId: place.ownerUserId, groupId: place.groupId };

  try {
    return await createBudget({
      ...budget,
      ...scope,
      accountId: accountId ?? null,
      labelId: labelId ?? null,
      name: name ?? null,
      limitCents,
    });
  } catch (error) {
    return mapBudgetError(error);
  }
}

/**
 * Rewrites a budget's editable fields (RF-71, RF-73). The category and the
 * scope are immutable and never travel in the payload, so a denied edit reports
 * as no row, the same as a budget that was never there.
 */
export async function reviseBudget({
  limit,
  accountId,
  labelId,
  name,
  ...budget
}: UpdateBudgetInput): Promise<void> {
  const currency = await resolveBudgetCurrency({
    budgetId: budget.budgetId,
    accountId: accountId ?? null,
  });
  const limitCents = toMinor(limit, currency);

  // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
  if (!budget.expectedUpdatedAt) throw new ActionError("errors.stale");

  let updated: Awaited<ReturnType<typeof updateBudget>>;
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

  if (updated === "stale") throw new ActionError("errors.stale");
  if (!updated) throw new ActionError("errors.notFound");
}
