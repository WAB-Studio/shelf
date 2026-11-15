import "server-only";

import {
  categoryFitsRuleAccount,
  createRecurringRule,
  setRecurringRuleActive,
  updateRecurringRule,
} from "@/db/queries/recurring-rules";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { assertRefined, requireMinor } from "@/lib/action-amounts";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import {
  type CreateRecurringRuleInput,
  refineRuleAmount,
  type UpdateRecurringRuleInput,
} from "@/lib/validation/recurring-rule";

// The writes behind the recurring rule forms' actions and behind `/mcp`: each takes input a Zod schema
// already parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

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
  assertRefined({ amount }, refineRuleAmount(settlement));
  return requireMinor(amount);
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
export async function openRecurringRule({
  amount,
  frequency,
  dayOfMonth,
  description,
  endsOn,
  ...rule
}: CreateRecurringRuleInput): Promise<{ recurringRuleId: string }> {
  const [amountCents] = await Promise.all([toMinor(amount, rule), assertCategoryFits(rule)]);

  try {
    return await createRecurringRule({
      ...rule,
      amountCents,
      frequency,
      dayOfMonth: dayForFrequency(frequency, dayOfMonth),
      description: description ?? null,
      endsOn: endsOn ?? null,
    });
  } catch (error) {
    return mapRecurringRuleError(error);
  }
}

/**
 * Rewrites a rule's definition (RF-29). `is_active` is the pause/resume path's to
 * write. `next_run_on` travels, and the database refuses one at or before the last
 * period the rule booked. A denied edit reports as no row.
 */
export async function reviseRecurringRule({
  amount,
  frequency,
  dayOfMonth,
  description,
  endsOn,
  ...rule
}: UpdateRecurringRuleInput): Promise<void> {
  // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
  if (!rule.expectedUpdatedAt) throw new ActionError("errors.stale");
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
}

// Pausing keeps the rule and its history; the generator skips it while `is_active`
// is false (RF-32). A false row count is a denied or absent rule.
export async function pauseRecurringRule(id: string): Promise<void> {
  const paused = await setRecurringRuleActive({ id, isActive: false });
  if (!paused) throw new ActionError("errors.notFound");
}

export async function resumeRecurringRule(id: string): Promise<void> {
  // 23514: the check refuses an active rule whose end date has passed.
  const resumed = await setRecurringRuleActive({ id, isActive: true }).catch((error) => {
    if (pgErrorCode(error) === "23514") throw new ActionError("recurringRules.errors.ended");
    throw error;
  });
  if (!resumed) throw new ActionError("errors.notFound");
}
