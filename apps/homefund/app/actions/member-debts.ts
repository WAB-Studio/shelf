"use server";

import { refresh } from "next/cache";

import { deleteMemberDebt, recordMemberDebt } from "@/db/queries/member-debts";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { deleteMemberDebtSchema, recordMemberDebtSchema } from "@/lib/validation/member-debt";

// RF-183: a debt between two members of the fund, or a payment of it.
export const recordMemberDebtAction = authActionClient
  .inputSchema(recordMemberDebtSchema)
  .action(async ({ parsedInput }) => {
    await recordMemberDebt(parsedInput);
    refresh();
  });

export const deleteMemberDebtAction = authActionClient
  .inputSchema(deleteMemberDebtSchema)
  .action(async ({ parsedInput: { id } }) => {
    const result = await deleteMemberDebt(id);
    if (result === "notFound") throw new ActionError("errors.notFound");
    if (result === "paid") throw new ActionError("memberDebts.errors.debtPaid");
    refresh();
  });
