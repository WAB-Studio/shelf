"use server";

import { refresh } from "next/cache";

import { payDebt } from "@/db/queries/debt-write";
import { authActionClient } from "@/lib/safe-action";
import { recordDebtPaymentSchema } from "@/lib/validation/installment-plan";

/**
 * Records a payment that credits a liability from an asset (RF-16); the write is `payDebt`'s,
 * shared with `/mcp`.
 */
export const recordDebtPaymentAction = authActionClient
  .inputSchema(recordDebtPaymentSchema)
  .action(async ({ parsedInput }) => {
    const paid = await payDebt(parsedInput);

    refresh();
    return paid;
  });
