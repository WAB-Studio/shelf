"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import {
  deleteInstallmentPlan,
  recordDebtPayment,
} from "@/db/queries/installment-plans";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  deleteInstallmentPlanSchema,
  recordDebtPaymentSchema,
  refineDebtPaymentAmount,
} from "@/lib/validation/installment-plan";

// An amount arrives as a Zod-validated string; turning it into the integer the
// column keeps can only fail if the refinement above let something through it
// should not have.
function toMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// The refinement the form runs, run again here against the currency read off the
// account rather than the one the payload claims (RNF-10). The first issue is
// what the caller is told, as every other refusal in this file reports one.
function assertAmounts<T>(
  data: T,
  refine: (data: T, ctx: z.RefinementCtx) => void,
): void {
  const verdict = z.custom<T>().superRefine(refine).safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
}

// The query's own kinds guard, both halves of it, raised before anything is written.
const ASSET_SOURCE_REFUSAL = "comes from an asset account";
const LIABILITY_TARGET_REFUSAL = "credits a liability account";

// The driver hangs its message off the cause chain the way it hangs its sqlstate:
// the error thrown only says which query failed.
function refusalMentions(error: unknown, fragment: string): boolean {
  let current: unknown = error;

  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) return false;

    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (typeof message === "string" && message.includes(fragment)) return true;

    current = cause;
  }

  return false;
}

// Four refusals share 23514: the two halves of the kinds guard above,
// `assert_installment_line_payment` when the settling movement does not touch the
// plan account, and `assert_installment_allocation` when the allocation is not
// oldest-first and in full. The message is what tells them apart — on the code
// alone every one of them would answer with the same key. A payment aimed at an
// account that is no debt says so with its own key. What is left over is the two triggers. A movement
// into another member's account — or into one just deleted — is denied by RLS
// (42501) and reads as absent. 23503 is the net under that: a reference gone
// after it was picked.
function mapPaymentError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  // A source and a debt that settle in different currencies: the movement would
  // carry a rate, and this path names no second amount for it (migration `0032`).
  if (code === "23901") throw new ActionError("transactions.errors.currencyMismatch");
  if (code === "23514") {
    if (refusalMentions(error, ASSET_SOURCE_REFUSAL)) {
      throw new ActionError("installments.errors.notFromAsset");
    }
    if (refusalMentions(error, LIABILITY_TARGET_REFUSAL)) {
      throw new ActionError("installments.errors.notLiability");
    }
    throw new ActionError("installments.errors.paymentInvalid");
  }
  if (code === "23503") throw new ActionError("errors.referenceGone");
  // A line this payment chose was linked by another first; the whole payment rolled back.
  if (code === "40001") throw new ActionError("errors.stale");
  throw error;
}

/**
 * Records a payment that credits a liability from an asset and allocates it
 * oldest-first onto the debt's unpaid lines (RF-16, RF-82). The transfer's scope
 * and kind fall to triggers; deleting the movement later unwinds the allocation
 * on its own, so there is no explicit unlink path. The lines it closed and the
 * remainder it left over travel back, so the caller can name both.
 *
 * The amount is read in the currency the SOURCE settles in, which is the one
 * `set_transaction_currency` books the movement in (RF-121). A source and a debt
 * that settle in different currencies make a movement that carries a rate, which
 * this path names no second amount for: `transactions_verify_currency` refuses
 * it, and the refusal maps below.
 *
 * A resent `requestRef` answers with the movement the first copy booked and the
 * lines stored against it. A link someone else's payment took between the read
 * and the write reports `errors.stale`, and nothing is booked.
 */
export const recordDebtPaymentAction = authActionClient
  .inputSchema(recordDebtPaymentSchema)
  .action(async ({ parsedInput: { fromAccountId, toAccountId, amount, occurredAt, requestRef } }) => {
    const settlement = await getSettlementCurrencies({ fromAccountId, toAccountId });
    const currency = settlement.from ?? BASE_CURRENCY;

    assertAmounts({ amount }, refineDebtPaymentAmount(currency));

    const amountCents = toMinor(amount);

    let result: Awaited<ReturnType<typeof recordDebtPayment>>;
    try {
      result = await recordDebtPayment({
        fromAccountId,
        toAccountId,
        amountCents,
        occurredAt,
        requestRef,
      });
    } catch (error) {
      mapPaymentError(error);
    }

    refresh();
    return {
      transactionId: result.transactionId,
      paidLineIds: result.paidLineIds,
      remainderCents: result.remainderCents,
      hasPlans: result.hasPlans,
    };
  });

// A denied or absent plan reports as no row (RF-81).
export const deleteInstallmentPlanAction = authActionClient
  .inputSchema(deleteInstallmentPlanSchema)
  .action(async ({ parsedInput: { planId } }) => {
    const deleted = await deleteInstallmentPlan({ planId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
