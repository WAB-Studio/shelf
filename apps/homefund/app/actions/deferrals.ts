"use server";

import { refresh } from "next/cache";

import { createDeferral, deleteDeferral } from "@/db/queries/deferrals";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { deferPurchaseSchema, undeferPurchaseSchema } from "@/lib/validation/deferral";

// A person's confirmation that a purchase on a card was deferred (RF-136). Only a purchase whose
// source is a liability account can be; an absent or hidden movement reads the same way.
export const deferPurchaseAction = authActionClient
  .inputSchema(deferPurchaseSchema)
  .action(async ({ parsedInput: { transactionId, instalments } }) => {
    try {
      if (!(await createDeferral({ transactionId, instalments }))) {
        throw new ActionError("deferrals.errors.notPurchase");
      }
    } catch (error) {
      // 23505: the movement already carries one; changing the count is remove and defer again.
      if (pgErrorCode(error) === "23505") throw new ActionError("deferrals.errors.alreadyDeferred");
      // 42501: a movement of another member's account.
      if (pgErrorCode(error) === "42501") throw new ActionError("errors.notFound");
      throw error;
    }

    refresh();
  });

export const undeferPurchaseAction = authActionClient
  .inputSchema(undeferPurchaseSchema)
  .action(async ({ parsedInput: { transactionId } }) => {
    if (!(await deleteDeferral({ transactionId }))) throw new ActionError("errors.notFound");

    refresh();
  });
