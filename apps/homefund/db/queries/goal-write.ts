import "server-only";

import { getUserGroup } from "@/db/queries/groups";
import {
  addGoalContribution,
  createGoal,
  resolveGoalCurrency,
  updateGoal,
} from "@/db/queries/savings-goals";
import { assertRefined, requireMinor } from "@/lib/action-amounts";
import type { CurrencyCode } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import {
  type ContributeGoalInput,
  type CreateGoalInput,
  refineContributionAmount,
  refineGoalAmounts,
  type UpdateGoalInput,
} from "@/lib/validation/savings-goal";

// The writes behind the goal forms' actions and behind `/mcp`: each takes input a Zod schema already
// parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

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
  assertRefined(amounts, refineGoalAmounts(currency));

  return {
    targetAmountCents: requireMinor(amounts.targetAmount),
    initialContributionCents:
      amounts.initialContribution != null
        ? requireMinor(amounts.initialContribution)
        : null,
  };
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
 * given, must share it. The owner comes from the session or the key, never the payload.
 */
export async function openGoal(
  { targetAmount, targetDate, accountId, initialContribution, ...goal }: CreateGoalInput,
  ownerUserId: string,
): Promise<{ goalId: string }> {
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
    : { ownerUserId, groupId: null };

  try {
    return await createGoal({
      ...goal,
      ...scope,
      targetAmountCents,
      targetDate: targetDate ?? null,
      accountId: accountId ?? null,
      initialContributionCents,
    });
  } catch (error) {
    return mapGoalError(error);
  }
}

/**
 * Rewrites a goal's editable fields (RF-76). The scope is immutable and never
 * travels in the payload, so a denied edit reports as no row.
 */
export async function reviseGoal({
  targetAmount,
  targetDate,
  accountId,
  ...goal
}: UpdateGoalInput): Promise<void> {
  const currency = await resolveGoalCurrency({
    goalId: goal.goalId,
    accountId: accountId ?? null,
  });
  const { targetAmountCents } = toGoalMinor({ targetAmount }, currency);

  // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
  if (!goal.expectedUpdatedAt) throw new ActionError("errors.stale");

  let updated: Awaited<ReturnType<typeof updateGoal>>;
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

  if (updated === "stale") throw new ActionError("errors.stale");
  if (!updated) throw new ActionError("errors.notFound");
}

/**
 * Adds a typed virtual aporte toward a goal (RF-87). The entry earmarks no
 * movement, so only the amount crosses, as a string read in the goal's currency.
 */
export async function contributeToGoal({
  goalId,
  amount,
}: ContributeGoalInput): Promise<{ contributionId: string }> {
  // An aporte is set aside in the goal's own currency, whatever it earmarks.
  const currency = await resolveGoalCurrency({ goalId });
  assertRefined({ amount }, refineContributionAmount(currency));

  const amountCents = requireMinor(amount);

  try {
    return await addGoalContribution({ goalId, amountCents });
  } catch (error) {
    return mapGoalError(error);
  }
}
