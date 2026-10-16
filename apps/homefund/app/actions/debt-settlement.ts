"use server";

import { refresh } from "next/cache";

import { recordBilledAmount } from "@/db/queries/debt-statements";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";
import { authActionClient } from "@/lib/safe-action";
import { recordBilledAmountSchema } from "@/lib/validation/debt-settlement";

/**
 * Writes what the issuer billed for one foreign-currency purchase (RF-123). The
 * amount arrives as the string the schema validated in the account's settlement
 * currency; the estimate it replaces is not kept anywhere, and no balance is
 * written — clearing the mark is what moves the figure between the account's
 * pockets, and `account_balances` derives the rest (RNF-07).
 *
 * The scope is the account's, through RLS: nothing about an owner or a group
 * travels here.
 */
export const recordBilledAmountAction = authActionClient
  .inputSchema(recordBilledAmountSchema)
  .action(
    async ({
      parsedInput: { transactionId, accountId, currency, billedAmount },
    }) => {
      // The schema already parsed this string, and the parse lands in the scale
      // the column keeps; a null here means the schema let through something it
      // should not have, which is not a field message.
      const billedCents = parseAmount(billedAmount);
      if (billedCents === null) throw new ActionError("errors.unexpected");

      let replaced: boolean;
      try {
        replaced = await recordBilledAmount({
          transactionId,
          accountId,
          currency,
          billedCents,
        });
      } catch (error) {
        // The UPDATE grant is column-scoped, so a caller outside it takes 42501
        // rather than the empty answer a denied policy gives.
        if (pgErrorCode(error) === "42501") {
          throw new ActionError("errors.notFound");
        }
        throw error;
      }

      // No row answered: the movement is not this card's, was billed already, or
      // the policies would not write it. One shape for the three.
      if (!replaced) throw new ActionError("errors.notFound");

      refresh();
    },
  );
