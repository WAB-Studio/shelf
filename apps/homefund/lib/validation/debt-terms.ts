import { z } from "zod";

import type { CurrencyCode } from "@/lib/currency";
import {
  anyCurrencyAmountSchema,
  minorAmountSchema,
} from "@/lib/validation/transaction";

// The two debt shapes the form and the DB enum read the same list (RF-78).
export const DEBT_KINDS = ["revolving", "installment"] as const;

// A rate travels as the percentage a person types — "28" or "28.5" — and the
// DB stores the fraction, so "28" becomes "0.28". The schema keeps the typed
// string; the action divides by 100 through `percentToFraction`, the one
// convention shared by form and server.
export function rateSchema(keys: { required: string; invalid: string }) {
  return z.string().superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      ctx.addIssue(keys.required);
      return;
    }

    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      ctx.addIssue(keys.invalid);
    }
  });
}

// The minimum-payment percentage a person types, 0..100; the same divide-by-100
// convention turns it into the fraction 0..1 the column checks (RF-80).
export function percentSchema(keys: { required: string; invalid: string }) {
  return z.string().superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      ctx.addIssue(keys.required);
      return;
    }

    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      ctx.addIssue(keys.invalid);
      return;
    }

    if (Number(trimmed) > 100) {
      ctx.addIssue(keys.invalid);
    }
  });
}

// Shifts a validated non-negative decimal string two places right of the
// decimal point — an exact string move, so "28.5" reads as "0.285" and no float
// rounds the rate the numeric column then stores.
export function percentToFraction(value: string): string {
  const [intPart, fracPart = ""] = value.trim().split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  const fractionLength = fracPart.length + 2;
  const padded = digits.padStart(fractionLength + 1, "0");
  const cut = padded.length - fractionLength;
  return `${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

// The three money fields, read by any offered currency: a field on its own
// cannot know its minor unit, since "10,50" is a dollar amount and no peso
// amount at all (RF-121). `refineDebtTermsAmounts` is the one right reading,
// run by the caller that knows what the account settles in.
const minimumKeys = {
  required: "debts.errors.minimumRequired",
  invalid: "debts.errors.minimumInvalid",
  tooLarge: "debts.errors.minimumTooLarge",
};

const creditLimitKeys = {
  required: "debts.errors.creditLimitRequired",
  invalid: "debts.errors.creditLimitInvalid",
  tooLarge: "debts.errors.creditLimitTooLarge",
};

const avalKeys = {
  required: "debts.errors.avalRequired",
  invalid: "debts.errors.avalInvalid",
  tooLarge: "debts.errors.avalTooLarge",
};

const minimumSchema = anyCurrencyAmountSchema(minimumKeys);
const creditLimitSchema = anyCurrencyAmountSchema(creditLimitKeys);
const avalSchema = anyCurrencyAmountSchema(avalKeys);

const checkMinimum = minorAmountSchema(minimumKeys);
const checkCreditLimit = minorAmountSchema(creditLimitKeys);
const checkAval = minorAmountSchema(avalKeys);

// Every money field of the profile, read in the currency the account bills in
// (RF-121): a credit limit and a minimum payment are denominated in what the
// card settles in, so how many decimals they may carry comes from that currency
// and from no other. The form runs this against the currency it was handed and
// the action against the one it reads off the account — the same rule, never the
// payload's word for it (RNF-10).
//
// An absent field is no amount at all; each field's own schema already refused
// the ones that read in no currency, so nothing here says the same thing twice.
export function refineDebtTermsAmounts(currency: CurrencyCode) {
  return function refine(
    data: {
      minimumPayment?: string | null;
      creditLimit?: string | null;
      aval?: string | null;
    },
    ctx: z.RefinementCtx,
  ) {
    if (data.minimumPayment != null) {
      checkMinimum(data.minimumPayment, currency, ["minimumPayment"], ctx);
    }
    if (data.creditLimit != null) {
      checkCreditLimit(data.creditLimit, currency, ["creditLimit"], ctx);
    }
    if (data.aval != null) {
      checkAval(data.aval, currency, ["aval"], ctx);
    }
  };
}

// A statement cut-off or payment due day-of-month; the DB clamps a 31 to a short
// month, so the schema only bounds the raw 1..31 range.
const dayOfMonthSchema = (key: string) =>
  z
    .number({ error: key })
    .int({ error: key })
    .min(1, { error: key })
    .max(31, { error: key });

// The debt profile carries no scope of its own: the account it hangs off gates
// it through RLS, so `accountId` is the only scope this payload names.
const debtTermsFields = {
  accountId: z.uuid({ error: "debts.errors.accountInvalid" }),
  debtKind: z.enum(DEBT_KINDS, { error: "debts.errors.kindInvalid" }),
  annualRate: rateSchema({
    required: "debts.errors.rateRequired",
    invalid: "debts.errors.rateInvalid",
  }),
  minimumPayment: minimumSchema.nullish(),
  minimumPaymentPct: percentSchema({
    required: "debts.errors.minimumPctRequired",
    invalid: "debts.errors.minimumPctInvalid",
  }).nullish(),
  creditLimit: creditLimitSchema.nullish(),
  statementCutOffDay: dayOfMonthSchema("debts.errors.cutOffDayInvalid").nullish(),
  paymentDueDay: dayOfMonthSchema("debts.errors.dueDayInvalid").nullish(),
  aval: avalSchema.nullish(),
};

// The minimum is a fixed amount XOR a percentage, or neither — never both, which
// mirrors the `debt_terms_minimum_amount_xor_pct` check.
function requireMinimumNotBoth(
  data: { minimumPayment?: string | null; minimumPaymentPct?: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.minimumPayment != null && data.minimumPaymentPct != null) {
    ctx.addIssue({
      code: "custom",
      message: "debts.errors.minimumBothSet",
      path: ["minimumPaymentPct"],
    });
  }
}

// One upsert path per account (RF-78, RF-80): the account key decides insert or
// in-place rewrite in the query.
export const debtTermsSchema = z
  .object(debtTermsFields)
  .superRefine(requireMinimumNotBoth);

export type DebtTermsInput = z.infer<typeof debtTermsSchema>;

export const deleteDebtTermsSchema = z.object({
  accountId: z.uuid({ error: "debts.errors.accountInvalid" }),
});

export type DeleteDebtTermsInput = z.infer<typeof deleteDebtTermsSchema>;
