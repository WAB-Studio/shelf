import { z } from "zod";

import { BASE_CURRENCY } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import {
  accountRefSchema,
  anyCurrencyAmountSchema,
  minorAmountSchema,
  occurredAtSchema,
  requireAnAccount,
  type SettlementCurrencies,
} from "@/lib/validation/transaction";

const amountKeys = {
  required: "plannedPayments.errors.amountRequired",
  invalid: "plannedPayments.errors.amountInvalid",
  tooLarge: "plannedPayments.errors.amountTooLarge",
};

// The field cannot know its minor unit until the accounts are read, so the
// shape passes if any offered currency reads it and `refinePaymentAmount` runs
// the one right reading (RF-121).
const amountSchema = anyCurrencyAmountSchema(amountKeys);

const checkAmount = minorAmountSchema(amountKeys);

/**
 * What the payment settles in: the source account's currency, or the
 * destination's when the payment is an income — the very `coalesce`
 * `set_transaction_currency` runs when the movement it plans is booked.
 */
export function plannedPaymentCurrency(settlement: SettlementCurrencies): string {
  return settlement.from ?? settlement.to ?? BASE_CURRENCY;
}

/**
 * The amount read in the currency the named account settles in (RF-121). The
 * form runs it against the currencies it was handed and the action against the
 * ones it reads back — the same rule on both sides (RNF-10).
 */
export function refinePaymentAmount(settlement: SettlementCurrencies) {
  return function refine(data: { amount: string }, ctx: z.RefinementCtx) {
    checkAmount(data.amount, plannedPaymentCurrency(settlement), ["amount"], ctx);
  };
}

// The day the payment falls due; unlike a movement it may sit in the future,
// so no not-future bound applies (RF-74).
const dueDateSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue("plannedPayments.errors.dueDateRequired");
    return;
  }

  if (!isCivilDate(value)) {
    ctx.addIssue("plannedPayments.errors.dueDateInvalid");
  }
});

// When to be reminded; optional, and never after the due date it precedes.
const remindOnSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isCivilDate(value)) {
      ctx.addIssue("plannedPayments.errors.remindOnInvalid");
    }
  })
  .nullish();

const descriptionSchema = z
  .string()
  .trim()
  .max(200, { error: "plannedPayments.errors.descriptionTooLong" })
  .nullish();

// A reminder that lands after the due date it belongs to would fire too late.
function requireRemindOnBeforeDue(
  data: { dueDate: string; remindOn?: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.remindOn != null && data.remindOn > data.dueDate) {
    ctx.addIssue({
      code: "custom",
      message: "plannedPayments.errors.remindOnAfterDue",
      path: ["remindOn"],
    });
  }
}

// The scope and `created_by` follow the accounts, set by the
// `set_planned_payment_scope` trigger and never sent; `status` and the settled
// movement are the settle/cancel paths' to write, so neither travels here.
const plannedPaymentFields = {
  fromAccountId: accountRefSchema,
  toAccountId: accountRefSchema,
  amount: amountSchema,
  categoryId: z.uuid({ error: "plannedPayments.errors.categoryInvalid" }).nullish(),
  dueDate: dueDateSchema,
  remindOn: remindOnSchema,
  description: descriptionSchema,
};

export const createPlannedPaymentSchema = z
  .object(plannedPaymentFields)
  .superRefine(requireAnAccount)
  .superRefine(requireRemindOnBeforeDue);

export type CreatePlannedPaymentInput = z.infer<typeof createPlannedPaymentSchema>;

export const updatePlannedPaymentSchema = z
  .object({
    plannedPaymentId: z.uuid({ error: "plannedPayments.errors.plannedPaymentInvalid" }),
    ...plannedPaymentFields,
  })
  .superRefine(requireAnAccount)
  .superRefine(requireRemindOnBeforeDue);

export type UpdatePlannedPaymentInput = z.infer<typeof updatePlannedPaymentSchema>;

// Settling records the real movement, so its date obeys the ledger's own
// not-future rule (RF-75).
export const settlePlannedPaymentSchema = z.object({
  plannedPaymentId: z.uuid({ error: "plannedPayments.errors.plannedPaymentInvalid" }),
  occurredAt: occurredAtSchema,
});

export type SettlePlannedPaymentInput = z.infer<typeof settlePlannedPaymentSchema>;

export const cancelPlannedPaymentSchema = z.object({
  plannedPaymentId: z.uuid({ error: "plannedPayments.errors.plannedPaymentInvalid" }),
});

export type CancelPlannedPaymentInput = z.infer<typeof cancelPlannedPaymentSchema>;

export const deletePlannedPaymentSchema = z.object({
  plannedPaymentId: z.uuid({ error: "plannedPayments.errors.plannedPaymentInvalid" }),
});

export type DeletePlannedPaymentInput = z.infer<typeof deletePlannedPaymentSchema>;
