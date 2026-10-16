import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { rateSchema } from "@/lib/validation/debt-terms";
import {
  anyCurrencyAmountSchema,
  minorAmountSchema,
  occurredAtSchema,
} from "@/lib/validation/transaction";

// The two schedules a plan can follow the same list the DB enum reads (RF-81).
export const INSTALLMENT_FREQUENCIES = ["monthly", "fortnightly"] as const;

// A plan's money fields, read by any offered currency: a field alone cannot know
// its minor unit (RF-121). `refineInstallmentPlanAmounts` is the one right
// reading, run by the caller that knows what the debt settles in.
const principalKeys = {
  required: "installments.errors.principalRequired",
  invalid: "installments.errors.principalInvalid",
  tooLarge: "installments.errors.principalTooLarge",
};

const downPaymentKeys = {
  required: "installments.errors.downPaymentRequired",
  invalid: "installments.errors.downPaymentInvalid",
  tooLarge: "installments.errors.downPaymentTooLarge",
};

const avalKeys = {
  required: "installments.errors.avalRequired",
  invalid: "installments.errors.avalInvalid",
  tooLarge: "installments.errors.avalTooLarge",
};

const paymentKeys = {
  required: "installments.errors.amountRequired",
  invalid: "installments.errors.amountInvalid",
  tooLarge: "installments.errors.amountTooLarge",
};

const principalSchema = anyCurrencyAmountSchema(principalKeys);
const downPaymentSchema = anyCurrencyAmountSchema(downPaymentKeys);
const avalSchema = anyCurrencyAmountSchema(avalKeys);

const checkPrincipal = minorAmountSchema(principalKeys);
const checkDownPayment = minorAmountSchema(downPaymentKeys);
const checkAval = minorAmountSchema(avalKeys);
const checkPayment = minorAmountSchema(paymentKeys);

/**
 * A plan schedules a balance the debt already carries, so every amount it names
 * is read in the currency that debt bills in (RF-81, RF-121). The form runs this
 * against the currency it was handed and the action against the one it reads off
 * the account — the same rule, never the payload's word for it (RNF-10).
 */
export function refineInstallmentPlanAmounts(currency: CurrencyCode) {
  return function refine(
    data: { principal: string; downPayment?: string | null; aval?: string | null },
    ctx: z.RefinementCtx,
  ) {
    checkPrincipal(data.principal, currency, ["principal"], ctx);
    if (data.downPayment != null) {
      checkDownPayment(data.downPayment, currency, ["downPayment"], ctx);
    }
    if (data.aval != null) {
      checkAval(data.aval, currency, ["aval"], ctx);
    }
  };
}

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

// The day the first installment falls; a plan schedules a future balance, so its
// start may sit ahead of today — no not-future bound applies (RF-81).
const startDateSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("installments.errors.startDateRequired");
    return;
  }

  if (!isCivilDate(value)) {
    ctx.addIssue("installments.errors.startDateInvalid");
  }
});

// The plan hangs off its account, so `accountId` is the only scope it names; the
// dated line schedule is derived server-side and never travels here.
export const createInstallmentPlanSchema = z.object({
  accountId: z.uuid({ error: "installments.errors.accountInvalid" }),
  description: z
    .string()
    .trim()
    .max(200, { error: "installments.errors.descriptionTooLong" })
    .nullish(),
  principal: principalSchema,
  nInstallments: z
    .number({ error: "installments.errors.installmentsInvalid" })
    .int({ error: "installments.errors.installmentsInvalid" })
    .min(1, { error: "installments.errors.installmentsInvalid" })
    .max(120, { error: "installments.errors.installmentsInvalid" }),
  frequency: z.enum(INSTALLMENT_FREQUENCIES, {
    error: "installments.errors.frequencyInvalid",
  }),
  interestRate: rateSchema({
    required: "installments.errors.rateRequired",
    invalid: "installments.errors.rateInvalid",
  }).nullish(),
  downPayment: downPaymentSchema.nullish(),
  aval: avalSchema.nullish(),
  startDate: startDateSchema,
  merchant: z
    .string()
    .trim()
    .max(120, { error: "installments.errors.merchantTooLong" })
    .nullish(),
});

export type CreateInstallmentPlanInput = z.infer<
  typeof createInstallmentPlanSchema
>;

// A payment credits a liability from an asset (RF-16, RF-82): both accounts are
// required and the date obeys the ledger's own not-future rule. The FIFO
// allocation onto lines is the query's, so no line ids travel here.
export const recordDebtPaymentSchema = z.object({
  fromAccountId: z.uuid({ error: "installments.errors.fromAccountInvalid" }),
  toAccountId: z.uuid({ error: "installments.errors.toAccountInvalid" }),
  amount: anyCurrencyAmountSchema(paymentKeys),
  occurredAt: occurredAtSchema,
});

export type RecordDebtPaymentInput = z.infer<typeof recordDebtPaymentSchema>;

export const deleteInstallmentPlanSchema = z.object({
  planId: z.uuid({ error: "installments.errors.planInvalid" }),
});

export type DeleteInstallmentPlanInput = z.infer<
  typeof deleteInstallmentPlanSchema
>;
