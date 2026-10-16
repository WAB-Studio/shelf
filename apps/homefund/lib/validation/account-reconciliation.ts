import { z } from "zod";

import { type CurrencyCode, OFFERED_CURRENCIES } from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import { maxAmountMinor, parseAmount } from "@/lib/money";
import { occurredAtSchema, pesoAmountSchema } from "@/lib/validation/transaction";

const realAmountKeys = {
  required: "errors.reconcileRealRequired",
  invalid: "transactions.errors.amountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
};

// One leading minus, either glyph, signs the counted figure. A sign the body repeats, a space
// or a plus after it is a malformed figure, never a guess at what the person meant.
function signedReal(value: string): { negative: boolean; body: string } | null {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-") || trimmed.startsWith("\u2212");
  const body = negative ? trimmed.slice(1) : trimmed;
  if (body.length === 0 || /^[\s+\-\u2212]/.test(body)) return null;
  return { negative, body };
}

/**
 * What a person counted on a day (RF-137). `realAmount` is the written figure, zero
 * allowed: signed first by the person, with one leading minus, then by the account's
 * own kind in `reconcileAccount`. The form checks it against any offered currency; the
 * action checks it again against the one it reads off the account, with
 * `checkRealAmount` (RNF-10).
 */
export const reconcileAccountSchema = z.object({
  accountId: z.uuid({ error: "transactions.errors.accountInvalid" }),
  reconciledOn: z
    .string()
    .refine(isCivilDate, { error: "transactions.errors.dateInvalid" })
    .refine((value) => !isCivilDate(value) || value <= todayInBogota(), {
      error: "errors.reconcileFutureDay",
    }),
  realAmount: z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue(realAmountKeys.required);
      return;
    }

    const read = signedReal(value);
    const cents = read === null ? null : parseAmount(read.body);
    if (cents === null) {
      ctx.addIssue(realAmountKeys.invalid);
      return;
    }

    if (OFFERED_CURRENCIES.every((currency) => cents > maxAmountMinor(currency))) {
      ctx.addIssue(realAmountKeys.tooLarge);
    }
  }),
  // The derived figure the person was shown; a different one now means the ledger moved.
  expectedDerivedCents: z.number().int(),
});

export type ReconcileAccountInput = z.infer<typeof reconcileAccountSchema>;

// The written figure read in one currency; the parsed value is its signed integer cents.
function realAmountInCurrency(currency: CurrencyCode) {
  return z.string().transform((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.required });
      return z.NEVER;
    }

    const read = signedReal(value);
    const cents = read === null ? null : parseAmount(read.body);
    if (read === null || cents === null) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.invalid });
      return z.NEVER;
    }

    if (cents > maxAmountMinor(currency)) {
      ctx.addIssue({ code: "custom", message: realAmountKeys.tooLarge });
      return z.NEVER;
    }

    // A counted «-0» is zero, never `-0`: the sign rides only on a figure that has one.
    return read.negative && cents !== 0 ? -cents : cents;
  });
}

/** The written figure in the account's own currency, signed, or the refusal's key. */
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
