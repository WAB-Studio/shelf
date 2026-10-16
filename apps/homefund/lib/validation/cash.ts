import { z } from "zod";

import { anyCurrencyAmountSchema } from "@/lib/validation/transaction";

// A withdrawal names only its source: the destination is the caller's cash,
// resolved server-side from `cash_mode`, never chosen (RF-68). The dialog does
// not know what the source settles in, so the field takes the widest reading
// the offered currencies allow and the action re-reads it in the source's own
// (RF-121) — the server refuses exactly what the dialog refuses (RNF-10), and
// then some.
export const withdrawCashSchema = z.object({
  sourceAccountId: z.uuid({ error: "cash.errors.sourceInvalid" }),
  amount: anyCurrencyAmountSchema({
    required: "cash.errors.amountRequired",
    invalid: "cash.errors.amountInvalid",
    tooLarge: "cash.errors.amountTooLarge",
  }),
});

export type WithdrawCashInput = z.infer<typeof withdrawCashSchema>;
