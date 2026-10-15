import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import {
  minorAmountSchema,
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

const readRealAmount = minorAmountSchema(realAmountKeys);

/** The written magnitude in the account's own currency, or the refusal's key. */
export function checkRealAmount(
  value: string,
  currency: CurrencyCode,
): { ok: true; cents: number } | { ok: false; messageKey: string } {
  let messageKey: string | null = null;
  const cents = readRealAmount(value, currency, [], {
    addIssue(issue: { message?: string }) {
      messageKey ??= issue.message ?? null;
    },
  } as z.RefinementCtx);

  return cents === null
    ? { ok: false, messageKey: messageKey ?? "errors.unexpected" }
    : { ok: true, cents };
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
