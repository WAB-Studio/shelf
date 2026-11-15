import "server-only";

import {
  createPlannedPayment,
  listPlannedPayments,
  settlePlannedPayment,
  updatePlannedPayment,
} from "@/db/queries/planned-payments";
import type { SettlePlannedPaymentResult } from "@/db/queries/planned-payments";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { assertRefined, requireMinor } from "@/lib/action-amounts";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import {
  type CreatePlannedPaymentInput,
  refinePaymentAmount,
  type SettlePlannedPaymentInput,
  type UpdatePlannedPaymentInput,
} from "@/lib/validation/planned-payment";

// The writes behind the planned payment forms' actions and behind `/mcp`: each takes input a Zod schema
// already parsed and throws an `ActionError` carrying a catalogue key, so both doors refuse in the same words.

/**
 * The amount read in the currency the named accounts settle in, never in the
 * one the payload implies (RF-121): the currencies come from the accounts, in
 * one round trip, and the refinement that reads the string against them is the
 * very one the form runs (RNF-10). Past it, a null parse can only be a schema
 * that let something through, so it is `errors.unexpected`.
 */
async function toMinor(
  amount: string,
  accounts: { fromAccountId: string | null; toAccountId: string | null },
): Promise<number> {
  const settlement = await getSettlementCurrencies(accounts);
  assertRefined({ amount }, refinePaymentAmount(settlement));
  return requireMinor(amount);
}

// The scope trigger raises 23514 when the accounts disagree on scope; a denied
// write reads as an absent payment, and a deleted account lands there too — the
// policy names both accounts, so it refuses before any foreign key. Nothing
// guards the category, so 23503 is the one it left: a category picked from the
// list and deleted before the payment was saved.
function mapPlannedPaymentError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  if (code === "23514") throw new ActionError("plannedPayments.errors.scopeViolation");
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Schedules a payment (RF-74). The scope and `created_by` follow the accounts,
 * set by the trigger and never sent; `status` starts pending on its own.
 */
export async function openPlannedPayment({
  amount,
  categoryId,
  remindOn,
  description,
  ...payment
}: CreatePlannedPaymentInput): Promise<{ plannedPaymentId: string }> {
  const amountCents = await toMinor(amount, payment);

  try {
    return await createPlannedPayment({
      ...payment,
      amountCents,
      categoryId: categoryId ?? null,
      remindOn: remindOn ?? null,
      description: description ?? null,
    });
  } catch (error) {
    return mapPlannedPaymentError(error);
  }
}

/**
 * Rewrites a pending payment's editable fields (RF-74). `status` and the settled
 * movement are the settle/cancel paths' to write, so neither travels here; a
 * denied edit reports as no row.
 */
export async function revisePlannedPayment({
  amount,
  categoryId,
  remindOn,
  description,
  ...payment
}: UpdatePlannedPaymentInput): Promise<void> {
  // RF-156: an edit sent without the stamp its form loaded is stale, refused before any write.
  if (!payment.expectedUpdatedAt) throw new ActionError("errors.stale");
  const amountCents = await toMinor(amount, payment);

  let updated: Awaited<ReturnType<typeof updatePlannedPayment>>;
  try {
    updated = await updatePlannedPayment({
      ...payment,
      amountCents,
      categoryId: categoryId ?? null,
      remindOn: remindOn ?? null,
      description: description ?? null,
    });
  } catch (error) {
    mapPlannedPaymentError(error);
  }

  if (updated === "stale") throw new ActionError("errors.stale");
  if (!updated) throw new ActionError("errors.notFound");
}

/**
 * Records the real movement the payment stood for and flips it to done (RF-161).
 * The payment's own accounts, amount and category become the transaction, so
 * the caller supplies only the date it actually happened; a payment no longer
 * pending — already settled or cancelled — surfaces as such, never a second
 * movement.
 */
export async function settlePlanned({
  plannedPaymentId,
  occurredAt,
}: SettlePlannedPaymentInput): Promise<{ transactionId: string }> {
  const pending = await listPlannedPayments({ status: "pending" });
  const payment = pending.find((row) => row.id === plannedPaymentId);
  if (!payment) throw new ActionError("errors.notFound");

  let result: SettlePlannedPaymentResult;
  try {
    result = await settlePlannedPayment({
      plannedPaymentId,
      fromAccountId: payment.fromAccountId,
      toAccountId: payment.toAccountId,
      amountCents: payment.amountCents,
      categoryId: payment.categoryId,
      occurredAt,
      description: payment.description,
    });
  } catch (error) {
    mapPlannedPaymentError(error);
  }

  if (!result.settled) throw new ActionError("plannedPayments.errors.alreadySettled");
  return { transactionId: result.transactionId };
}
