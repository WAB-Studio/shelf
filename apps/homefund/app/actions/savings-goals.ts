"use server";

import { refresh } from "next/cache";

import { z } from "zod";

import { getUserGroup } from "@/db/queries/groups";
import {
  addGoalContribution,
  archiveGoal,
  createGoal,
  deleteGoal,
  listGoalContributions,
  removeGoalContribution,
  resolveGoalCurrency,
  restoreGoal,
  updateGoal,
  type GoalContributionRow,
} from "@/db/queries/savings-goals";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  archiveGoalSchema,
  contributeGoalSchema,
  createGoalSchema,
  deleteGoalSchema,
  goalContributionsSchema,
  refineContributionAmount,
  refineGoalAmounts,
  removeGoalContributionSchema,
  restoreGoalSchema,
  updateGoalSchema,
} from "@/lib/validation/savings-goal";

/**
 * The meta and the opening aporte read in the currency the goal derives, never
 * in the one the payload implies (RF-121). The refinement is the very one the
 * form runs (RNF-10); past it, a null parse can only be a schema that let
 * something through, so it is `errors.unexpected` and not a field message.
 */
function toGoalMinor(
  amounts: { targetAmount: string; initialContribution?: string | null },
  currency: CurrencyCode,
): { targetAmountCents: number; initialContributionCents: number | null } {
  const verdict = z
    .custom<typeof amounts>()
    .superRefine(refineGoalAmounts(currency))
    .safeParse(amounts);

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  return {
    targetAmountCents: toMinor(amounts.targetAmount),
    initialContributionCents:
      amounts.initialContribution != null
        ? toMinor(amounts.initialContribution)
        : null,
  };
}

function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// A scope mismatch on the goal's account, or on a contributed movement, raises
// 23514; a missing account or movement trips a foreign key; a denied write
// reads the same as a goal that was never there.
function mapGoalError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("goals.errors.scopeViolation");
  if (code === "23503") throw new ActionError("errors.notFound");
  throw error;
}

/**
 * Creates a savings goal (RF-76). The scope follows the named account when the
 * caller belongs to a group, otherwise their personal set; the account, when
 * given, must share it.
 */
export const createGoalAction = authActionClient
  .inputSchema(createGoalSchema)
  .action(
    async ({
      parsedInput: { targetAmount, targetDate, accountId, initialContribution, ...goal },
      ctx,
    }) => {
      // The currency and the scope ride one fan-out: neither read waits on the other.
      const [currency, group] = await Promise.all([
        resolveGoalCurrency({ accountId: accountId ?? null }),
        getUserGroup(),
      ]);
      const { targetAmountCents, initialContributionCents } = toGoalMinor(
        { targetAmount, initialContribution },
        currency,
      );

      const scope = group
        ? { ownerUserId: null, groupId: group.id }
        : { ownerUserId: ctx.user.id, groupId: null };

      let goalId: string;
      try {
        ({ goalId } = await createGoal({
          ...goal,
          ...scope,
          targetAmountCents,
          targetDate: targetDate ?? null,
          accountId: accountId ?? null,
          initialContributionCents,
        }));
      } catch (error) {
        mapGoalError(error);
      }

      refresh();
      return { goalId };
    },
  );

/**
 * Rewrites a goal's editable fields (RF-76). The scope is immutable and never
 * travels in the payload, so a denied edit reports as no row.
 */
export const updateGoalAction = authActionClient
  .inputSchema(updateGoalSchema)
  .action(async ({ parsedInput: { targetAmount, targetDate, accountId, ...goal } }) => {
    const currency = await resolveGoalCurrency({
      goalId: goal.goalId,
      accountId: accountId ?? null,
    });
    const { targetAmountCents } = toGoalMinor({ targetAmount }, currency);

    let updated: boolean;
    try {
      updated = await updateGoal({
        ...goal,
        targetAmountCents,
        targetDate: targetDate ?? null,
        accountId: accountId ?? null,
      });
    } catch (error) {
      mapGoalError(error);
    }

    if (!updated) throw new ActionError("errors.notFound");

    refresh();
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

/**
 * Adds a typed virtual aporte toward a goal (RF-87). The entry earmarks no
 * movement, so only the amount crosses, as a string read in the goal's currency.
 */
export const contributeGoalAction = authActionClient
  .inputSchema(contributeGoalSchema)
  .action(async ({ parsedInput: { goalId, amount } }) => {
    // An aporte is set aside in the goal's own currency, whatever it earmarks.
    const currency = await resolveGoalCurrency({ goalId });
    const verdict = z
      .custom<{ amount: string }>()
      .superRefine(refineContributionAmount(currency))
      .safeParse({ amount });

    if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

    const amountCents = toMinor(amount);

    let contributionId: string;
    try {
      ({ contributionId } = await addGoalContribution({ goalId, amountCents }));
    } catch (error) {
      mapGoalError(error);
    }

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
