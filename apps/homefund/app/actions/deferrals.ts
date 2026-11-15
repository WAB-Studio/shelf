"use server";

import { refresh } from "next/cache";

import { deferPurchase, undeferPurchase } from "@/db/queries/statement-write";
import { authActionClient } from "@/lib/safe-action";
import { deferPurchaseSchema, undeferPurchaseSchema } from "@/lib/validation/deferral";

export const deferPurchaseAction = authActionClient
  .inputSchema(deferPurchaseSchema)
  .action(async ({ parsedInput }) => {
    await deferPurchase(parsedInput);

    refresh();
  });

export const undeferPurchaseAction = authActionClient
  .inputSchema(undeferPurchaseSchema)
  .action(async ({ parsedInput }) => {
    await undeferPurchase(parsedInput);

    refresh();
  });
