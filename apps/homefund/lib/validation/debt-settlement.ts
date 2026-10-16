import { z } from "zod";

import { isCurrencyCode } from "@/lib/currency";
import { maxAmountMinor, parseAmount } from "@/lib/money";

// The currency the typed amount is read in. It travels with the payload because
// it decides how many decimals the text may carry, and the write refuses a code
// the account does not settle in — so a client that names another one moves no
// decimal point.
const settlementCurrencySchema = z
  .string()
  .refine(isCurrencyCode, { error: "accounts.errors.currencyInvalid" });

/**
 * What the issuer billed for one foreign-currency purchase (RF-123): an amount
 * written in the account's settlement currency, which replaces the estimate the
 * movement carries. `parseAmount` is the one thing that reads it into the integer
 * the column keeps, here and in the action. One schema for the row's form and for
 * the action (RNF-10).
 */
export const recordBilledAmountSchema = z
  .object({
    transactionId: z.uuid({ error: "errors.notFound" }),
    accountId: z.uuid({ error: "debts.errors.accountInvalid" }),
    currency: settlementCurrencySchema,
    billedAmount: z.string(),
  })
  .superRefine((data, ctx) => {
    // The currency is what the parse below reads the string in, so a code the
    // runtime does not know has already said everything there is to say.
    if (!isCurrencyCode(data.currency)) return;

    const value = data.billedAmount.trim();
    if (value.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.counterAmountRequired",
        path: ["billedAmount"],
      });
      return;
    }

    // Zero is not a bill, and `transactions_counter_amount_positive` refuses it.
    const billedCents = parseAmount(value);
    if (billedCents === null || billedCents === 0) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.counterAmountInvalid",
        path: ["billedAmount"],
      });
      return;
    }

    if (billedCents > maxAmountMinor(data.currency)) {
      ctx.addIssue({
        code: "custom",
        message: "transactions.errors.amountTooLarge",
        path: ["billedAmount"],
      });
    }
  });

export type RecordBilledAmountInput = z.infer<typeof recordBilledAmountSchema>;
