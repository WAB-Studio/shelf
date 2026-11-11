"use server";

import { refresh } from "next/cache";

import { recordDebtPayment } from "@/db/queries/installment-plans";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { BASE_CURRENCY } from "@/lib/currency";
import { requireMinor, assertRefined } from "@/lib/action-amounts";
import { pgErrorCode, pgErrorMentions } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  recordDebtPaymentSchema,
  refineDebtPaymentAmount,
} from "@/lib/validation/installment-plan";

// The query's own kinds guard, both halves of it, raised before anything is written.
const ASSET_SOURCE_REFUSAL = "comes from an asset account";
const LIABILITY_TARGET_REFUSAL = "credits a liability account";

// Two refusals share 23514: the two halves of the kinds guard above, told apart by the message and
// each answered with its own key; anything else the constraint refuses reads as an invalid payment. A
// movement into another member's account — or into one just deleted — is denied by RLS (42501) and
// reads as absent. 23503 is the net under that: a reference gone after it was picked.
function mapPaymentError(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === "42501") throw new ActionError("errors.notFound");
  // A source and a debt that settle in different currencies: the movement would
  // carry a rate, and this path names no second amount for it (migration `0032`).
  if (code === "23901") throw new ActionError("transactions.errors.currencyMismatch");
  if (code === "23514") {
    if (pgErrorMentions(error, ASSET_SOURCE_REFUSAL)) {
      throw new ActionError("installments.errors.notFromAsset");
    }
    if (pgErrorMentions(error, LIABILITY_TARGET_REFUSAL)) {
      throw new ActionError("installments.errors.notLiability");
    }
    throw new ActionError("installments.errors.paymentInvalid");
  }
  if (code === "23503") throw new ActionError("errors.referenceGone");
  throw error;
}

/**
 * Records a payment that credits a liability from an asset (RF-16). The
 * transfer's scope and kind fall to triggers.
 *
 * The amount is read in the currency the SOURCE settles in, which is the one
 * `set_transaction_currency` books the movement in (RF-121). A source and a debt
 * that settle in different currencies make a movement that carries a rate, which
 * this path names no second amount for: `transactions_verify_currency` refuses
 * it, and the refusal maps below.
 *
 * A resent `requestRef` answers with the movement the first copy booked.
 */
export const recordDebtPaymentAction = authActionClient
  .inputSchema(recordDebtPaymentSchema)
  .action(async ({ parsedInput: { fromAccountId, toAccountId, amount, occurredAt, requestRef } }) => {
    const settlement = await getSettlementCurrencies({ fromAccountId, toAccountId });
    const currency = settlement.from ?? BASE_CURRENCY;

    assertRefined({ amount }, refineDebtPaymentAmount(currency));

    const amountCents = requireMinor(amount);

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
    return { transactionId: result.transactionId };
  });
