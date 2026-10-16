import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import { maxAmountMinor, parseAmount } from "@/lib/money";
import {
  anyCurrencyAmountSchema,
  occurredAtSchema,
  pesoAmountSchema,
} from "@/lib/validation/transaction";

const realAmountKeys = {
  required: "errors.reconcileRealRequired",
  invalid: "transactions.errors.amountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
};

/**
 * What a person counted on a day (RF-137). `realAmount` is the written magnitude,
 * zero allowed and never signed: `reconcileAccount` signs it by the account's own
 * kind. The form checks it against any offered currency; the action checks it again
 * against the one it reads off the account, with `checkRealAmount` (RNF-10).
 */
export const reconcileAccountSchema = z.object({
  accountId: z.uuid({ error: "transactions.errors.accountInvalid" }),
  reconciledOn: z
    .string()
    .refine(isCivilDate, { error: "transactions.errors.dateInvalid" })
    .refine((value) => !isCivilDate(value) || value <= todayInBogota(), {
      error: "errors.reconcileFutureDay",
    }),
  realAmount: anyCurrencyAmountSchema(realAmountKeys),
  // The derived figure the person was shown; a different one now means the ledger moved.
  expectedDerivedCents: z.number().int(),
});

export type ReconcileAccountInput = z.infer<typeof reconcileAccountSchema>;

// The written magnitude read in one currency; the parsed value is its integer cents.
function realAmountInCurrency(currency: CurrencyCode) {
  return z.string().transform((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.required });
      return z.NEVER;
    }

    const cents = parseAmount(value);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.invalid });
      return z.NEVER;
    }

    if (cents > maxAmountMinor(currency)) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.tooLarge });
      return z.NEVER;
    }

    return cents;
  });
}

/** The written magnitude in the account's own currency, or the refusal's key. */
export function checkRealAmount(
  value: string,
  currency: CurrencyCode,
): { ok: true; cents: number } | { ok: false; messageKey: string } {
  const result = realAmountInCurrency(currency).safeParse(value);

  return result.success
    ? { ok: true, cents: result.data }
    : { ok: false, messageKey: result.error.issues[0]?.message ?? "errors.unexpected" };
}

/**
 * An adjustment row of a backup (RF-50, RF-137): the gap one account was booked, on the day
 * it was counted. `direction` says which way the account moved; the amount is its magnitude.
 * The import books it as a reconciliation, so it stays out of income and expense (RF-138).
 */
export const importedAdjustmentSchema = z.object({
  adjustment: z.literal(true),
  accountId: z.uuid({ error: "transactions.errors.accountInvalid" }),
  direction: z.enum(["up", "down"]),
  amount: pesoAmountSchema({
    required: "transactions.errors.amountRequired",
    invalid: "transactions.errors.amountInvalid",
    tooLarge: "transactions.errors.amountTooLarge",
  }),
  occurredAt: occurredAtSchema,
});

export type ImportedAdjustment = z.infer<typeof importedAdjustmentSchema>;
