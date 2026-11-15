"use server";

import { refresh } from "next/cache";

import {
  openPlannedPayment,
  revisePlannedPayment,
  settlePlanned,
} from "@/db/queries/planned-payment-write";
import { cancelPlannedPayment, deletePlannedPayment } from "@/db/queries/planned-payments";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  cancelPlannedPaymentSchema,
  createPlannedPaymentSchema,
  deletePlannedPaymentSchema,
  settlePlannedPaymentSchema,
  updatePlannedPaymentSchema,
} from "@/lib/validation/planned-payment";

/** Schedules a payment (RF-74); `openPlannedPayment` holds the body. */
export const createPlannedPaymentAction = authActionClient
  .inputSchema(createPlannedPaymentSchema)
  .action(async ({ parsedInput }) => {
    const { plannedPaymentId } = await openPlannedPayment(parsedInput);

    refresh();
    return { plannedPaymentId };
  });

/** Rewrites a pending payment's editable fields (RF-74); `revisePlannedPayment` holds the body. */
export const updatePlannedPaymentAction = authActionClient
  .inputSchema(updatePlannedPaymentSchema)
  .action(async ({ parsedInput }) => {
    await revisePlannedPayment(parsedInput);

    refresh();
  });

export const deletePlannedPaymentAction = authActionClient
  .inputSchema(deletePlannedPaymentSchema)
  .action(async ({ parsedInput: { plannedPaymentId } }) => {
    const deleted = await deletePlannedPayment({ plannedPaymentId });
    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });

/** Records the real movement the payment stood for and flips it to done (RF-161); `settlePlanned` holds the body. */
export const settlePlannedPaymentAction = authActionClient
  .inputSchema(settlePlannedPaymentSchema)
  .action(async ({ parsedInput }) => {
    const { transactionId } = await settlePlanned(parsedInput);

    refresh();
    return { transactionId };
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
