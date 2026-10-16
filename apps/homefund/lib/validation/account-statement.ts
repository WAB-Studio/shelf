import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import { isCurrencyCode } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { maxAmountMinor, parseAmount } from "@/lib/money";

// The currency the typed amounts are read in. It travels with the payload for
// the same reason `recordBilledAmountSchema` carries one: the action re-reads
// it off the account rather than trusting this field (RNF-10).
const settlementCurrencySchema = z
  .string()
  .refine(isCurrencyCode, { error: "accounts.errors.currencyInvalid" });

const closingKeys = {
  required: "installments.errors.closingRequired",
  invalid: "installments.errors.closingInvalid",
  tooLarge: "installments.errors.closingTooLarge",
};

// A blank optional field is `null` on the wire, never the empty string a text
// input starts from — the dialog owns that conversion. A stray blank string
// reads the same way, so a field that is never required does not turn one
// into a spurious "invalid" a moment later.
function normalizeBlank(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  return value;
}

const optionalFigureField = z.string().nullable().transform(normalizeBlank);
const optionalDateField = z.string().nullable().transform(normalizeBlank);

// The one required figure: a statement with no closing balance closes nothing.
function checkRequiredFigure(
  value: string,
  currency: CurrencyCode,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (value.trim().length === 0) {
    ctx.addIssue({ code: "custom", message: closingKeys.required, path });
    return;
  }

  const minor = parseAmount(value);
  if (minor === null) {
    ctx.addIssue({ code: "custom", message: closingKeys.invalid, path });
    return;
  }

  if (minor > maxAmountMinor(currency)) {
    ctx.addIssue({ code: "custom", message: closingKeys.tooLarge, path });
  }
}

// Every other printed figure: absent when the statement never printed it, one
// message shared across the six since none of them needs a field of its own.
function checkOptionalFigure(
  value: string | null,
  currency: CurrencyCode,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (value === null) return;

  const minor = parseAmount(value);
  if (minor === null) {
    ctx.addIssue({
      code: "custom",
      message: "installments.errors.figureInvalid",
      path,
    });
    return;
  }

  if (minor > maxAmountMinor(currency)) {
    ctx.addIssue({
      code: "custom",
      message: "installments.errors.figureTooLarge",
      path,
    });
  }
}

/**
 * Every printed figure, read in the currency the statement's account settles
 * in (RF-121, RF-129, RF-130). The form runs this against the currency it was
 * handed and the action against the one it reads off the account — the same
 * rule on both sides (RNF-10), and the one place either side checks a figure.
 */
export function refineAccountStatementAmounts(currency: CurrencyCode) {
  return function refine(
    data: {
      closingBalance: string;
      openingBalance: string | null;
      credits: string | null;
      debits: string | null;
      minimumPayment: string | null;
      interestCharged: string | null;
      feesCharged: string | null;
    },
    ctx: z.RefinementCtx,
  ) {
    checkRequiredFigure(data.closingBalance, currency, ["closingBalance"], ctx);
    checkOptionalFigure(data.openingBalance, currency, ["openingBalance"], ctx);
    checkOptionalFigure(data.credits, currency, ["credits"], ctx);
    checkOptionalFigure(data.debits, currency, ["debits"], ctx);
    checkOptionalFigure(
      data.minimumPayment,
      currency,
      ["minimumPayment"],
      ctx,
    );
    checkOptionalFigure(
      data.interestCharged,
      currency,
      ["interestCharged"],
      ctx,
    );
    checkOptionalFigure(data.feesCharged, currency, ["feesCharged"], ctx);
  };
}

/**
 * A closed statement (RF-129, RF-130): the period it covers, its cut-off and,
 * for a liability, when it falls due, plus what the statement printed. Every
 * amount here is the unsigned magnitude the statement itself shows —
 * `recordAccountStatement` resolves the sign from the account's own kind, the
 * same shape `createAccountSchema` gives its opening balance.
 */
export const recordAccountStatementSchema = z
  .object({
    accountId: z.uuid({ error: "installments.errors.accountInvalid" }),
    currency: settlementCurrencySchema,
    periodStart: z.string(),
    cutOffDate: z.string(),
    paymentDueDate: optionalDateField,
    openingBalance: optionalFigureField,
    closingBalance: z.string(),
    credits: optionalFigureField,
    debits: optionalFigureField,
    minimumPayment: optionalFigureField,
    interestCharged: optionalFigureField,
    feesCharged: optionalFigureField,
  })
  .superRefine((data, ctx) => {
    if (data.cutOffDate.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "installments.errors.cutOffRequired",
        path: ["cutOffDate"],
      });
    } else if (!isCivilDate(data.cutOffDate)) {
      ctx.addIssue({
        code: "custom",
        message: "installments.errors.cutOffInvalid",
        path: ["cutOffDate"],
      });
    }

    const cutOffValid = isCivilDate(data.cutOffDate);

    if (data.periodStart.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "installments.errors.startDateRequired",
        path: ["periodStart"],
      });
    } else if (!isCivilDate(data.periodStart)) {
      ctx.addIssue({
        code: "custom",
        message: "installments.errors.startDateInvalid",
        path: ["periodStart"],
      });
    } else if (cutOffValid && data.periodStart > data.cutOffDate) {
      // Mirrors `account_statements_period_before_cut_off`.
      ctx.addIssue({
        code: "custom",
        message: "installments.errors.periodStartAfterCutOff",
        path: ["periodStart"],
      });
    }

    if (data.paymentDueDate !== null) {
      if (!isCivilDate(data.paymentDueDate)) {
        ctx.addIssue({
          code: "custom",
          message: "installments.errors.startDateInvalid",
          path: ["paymentDueDate"],
        });
      } else if (cutOffValid && data.paymentDueDate < data.cutOffDate) {
        // Mirrors `account_statements_due_after_cut_off`.
        ctx.addIssue({
          code: "custom",
          message: "installments.errors.dueBeforeCutOff",
          path: ["paymentDueDate"],
        });
      }
    }

    // The currency's own shape already failed above; reading amounts against a
    // code the runtime does not know would only repeat that one issue for
    // every field it names.
    if (!isCurrencyCode(data.currency)) return;

    refineAccountStatementAmounts(data.currency)(data, ctx);
  });

export type RecordAccountStatementInput = z.infer<
  typeof recordAccountStatementSchema
>;
