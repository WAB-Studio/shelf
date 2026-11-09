import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import {
  anyCurrencyAmountSchema,
  minorAmountSchema,
  occurredAtSchema,
} from "@/lib/validation/transaction";

const paymentKeys = {
  required: "installments.errors.amountRequired",
  invalid: "installments.errors.amountInvalid",
  tooLarge: "installments.errors.amountTooLarge",
};

const checkPayment = minorAmountSchema(paymentKeys);

/**
 * A payment is booked in the currency its SOURCE settles in — the one the
 * `set_transaction_currency` trigger derives from the accounts (RF-16, RF-121),
 * which is what decides how many decimals the typed amount may carry.
 */
export function refineDebtPaymentAmount(currency: CurrencyCode) {
  return function refine(data: { amount: string }, ctx: z.RefinementCtx) {
    checkPayment(data.amount, currency, ["amount"], ctx);
  };
}

// A payment credits a liability from an asset (RF-16, RF-82): both accounts are
// required and the date obeys the ledger's own not-future rule. The FIFO
// allocation onto lines is the query's, so no line ids travel here.
export const recordDebtPaymentSchema = z.object({
  fromAccountId: z.uuid({ error: "installments.errors.fromAccountInvalid" }),
  toAccountId: z.uuid({ error: "installments.errors.toAccountInvalid" }),
  amount: anyCurrencyAmountSchema(paymentKeys),
  occurredAt: occurredAtSchema,
  // Minted by the form when it opens: a submit sent again after a lost answer carries the same
  // one, and the server answers with the payment the first copy booked.
  requestRef: z.uuid({ error: "errors.unexpected" }).optional(),
});

export type RecordDebtPaymentInput = z.infer<typeof recordDebtPaymentSchema>;

export const deleteInstallmentPlanSchema = z.object({
  planId: z.uuid({ error: "installments.errors.planInvalid" }),
});

