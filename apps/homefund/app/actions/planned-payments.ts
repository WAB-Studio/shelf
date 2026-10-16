"use server";

import { refresh } from "next/cache";

import { z } from "zod";

import {
  cancelPlannedPayment,
  createPlannedPayment,
  deletePlannedPayment,
  listPlannedPayments,
  settlePlannedPayment,
  updatePlannedPayment,
} from "@/db/queries/planned-payments";
import type { SettlePlannedPaymentResult } from "@/db/queries/planned-payments";
import { getSettlementCurrencies } from "@/db/queries/transactions";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import {
  cancelPlannedPaymentSchema,
  createPlannedPaymentSchema,
  deletePlannedPaymentSchema,
  refinePaymentAmount,
  settlePlannedPaymentSchema,
  updatePlannedPaymentSchema,
} from "@/lib/validation/planned-payment";

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
  const verdict = z
    .custom<{ amount: string }>()
    .superRefine(refinePaymentAmount(settlement))
    .safeParse({ amount });

  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);

  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
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
export const createPlannedPaymentAction = authActionClient
  .inputSchema(createPlannedPaymentSchema)
  .action(async ({ parsedInput: { amount, categoryId, remindOn, description, ...payment } }) => {
    const amountCents = await toMinor(amount, payment);

    let plannedPaymentId: string;
    try {
      ({ plannedPaymentId } = await createPlannedPayment({
        ...payment,
        amountCents,
        categoryId: categoryId ?? null,
        remindOn: remindOn ?? null,
        description: description ?? null,
      }));
    } catch (error) {
      mapPlannedPaymentError(error);
    }

    refresh();
    return { plannedPaymentId };
  });

/**
 * Rewrites a pending payment's editable fields (RF-74). `status` and the settled
 * movement are the settle/cancel paths' to write, so neither travels here; a
 * denied edit reports as no row.
 */
export const updatePlannedPaymentAction = authActionClient
  .inputSchema(updatePlannedPaymentSchema)
  .action(async ({ parsedInput: { amount, categoryId, remindOn, description, ...payment } }) => {
    const amountCents = await toMinor(amount, payment);

    let updated: boolean;
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

    if (!updated) throw new ActionError("errors.notFound");

    refresh();
  });

export const deletePlannedPaymentAction = authActionClient
  .inputSchema(deletePlannedPaymentSchema)
  .action(async ({ parsedInput: { plannedPaymentId } }) => {
    const deleted = await deletePlannedPayment({ plannedPaymentId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });

/**
 * Records the real movement the payment stood for and flips it to done (RF-75).
 * The payment's own accounts, amount and category become the transaction, so
 * the form supplies only the date it actually happened; a payment no longer
 * pending — already settled or cancelled — surfaces as such, never a second
 * movement.
 */
export const settlePlannedPaymentAction = authActionClient
  .inputSchema(settlePlannedPaymentSchema)
  .action(async ({ parsedInput: { plannedPaymentId, occurredAt } }) => {
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

    refresh();
    return { transactionId: result.transactionId };
  });

// Only a pending payment can be cancelled; a false row count is a payment that
// was already terminal, denied or absent (RF-74).
export const cancelPlannedPaymentAction = authActionClient
  .inputSchema(cancelPlannedPaymentSchema)
  .action(async ({ parsedInput: { plannedPaymentId } }) => {
    const cancelled = await cancelPlannedPayment({ plannedPaymentId });
    if (!cancelled) throw new ActionError("errors.notFound");

    refresh();
  });
