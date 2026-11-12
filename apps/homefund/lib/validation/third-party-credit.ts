import { z } from "zod";

import { BASE_CURRENCY } from "@/lib/currency";
import { maxAmountMinor, parseAmount } from "@/lib/money";
import { minorAmountSchema, occurredAtSchema } from "@/lib/validation/transaction";

const checkAmount = minorAmountSchema({
  required: "thirdPartyCredit.errors.amountRequired",
  invalid: "thirdPartyCredit.errors.amountInvalid",
  tooLarge: "thirdPartyCredit.errors.amountTooLarge",
});

const checkPayment = minorAmountSchema({
  required: "transactions.errors.amountRequired",
  invalid: "transactions.errors.amountInvalid",
  tooLarge: "transactions.errors.amountTooLarge",
});

const accountId = (error: string) => z.uuid({ error });

const personName = z
  .string({ error: "thirdPartyCredit.errors.nameRequired" })
  .trim()
  .min(1, { error: "thirdPartyCredit.errors.nameRequired" })
  .max(80, { error: "thirdPartyCredit.errors.nameTooLong" });

// What the lender asks each month and the day it is due: both are optional, so a blank field is none. The
// form and the server read the same text with the same rules.
const lenderTerms = {
  installmentAmount: z.string(),
  dueDay: z.string(),
};

function readLenderTerms(
  data: { installmentAmount: string; dueDay: string },
  ctx: z.RefinementCtx,
): { installmentCents: number | null; dueDay: number | null } | null {
  let installmentCents: number | null = null;
  if (data.installmentAmount.trim() !== "") {
    installmentCents = parseAmount(data.installmentAmount);
    if (installmentCents === null || installmentCents === 0 || installmentCents > maxAmountMinor(BASE_CURRENCY)) {
      ctx.addIssue({ code: "custom", message: "thirdPartyCredit.errors.installmentInvalid", path: ["installmentAmount"] });
      return null;
    }
  }
  let dueDay: number | null = null;
  if (data.dueDay.trim() !== "") {
    dueDay = /^\d{1,2}$/.test(data.dueDay.trim()) ? Number(data.dueDay.trim()) : Number.NaN;
    if (!(dueDay >= 1 && dueDay <= 31)) {
      ctx.addIssue({ code: "custom", message: "thirdPartyCredit.errors.dueDayInvalid", path: ["dueDay"] });
      return null;
    }
  }
  return { installmentCents, dueDay };
}

// RF-211: «Lo paga otra persona» on a credit: who pays it, the «Me debe» account their debt sits in (a new one
// opened at `amount`, or one the person already has) and what the lender asks each month. The form sends text.
export const setUpThirdPartyCreditSchema = z
  .object({
    liabilityAccountId: accountId("errors.notFound"),
    personName,
    receivableAccountId: z
      .union([accountId("thirdPartyCredit.errors.receivableInvalid"), z.literal("")])
      .nullish()
      .transform((value) => value || null),
    // Read only when a new receivable is opened.
    amount: z.string(),
    openedOn: occurredAtSchema,
    ...lenderTerms,
  })
  .transform((data, ctx) => {
    let openingCents = 0;
    if (data.receivableAccountId === null) {
      const opening = checkAmount(data.amount, BASE_CURRENCY, ["amount"], ctx);
      if (opening === null) return z.NEVER;
      openingCents = opening;
    }
    const terms = readLenderTerms(data, ctx);
    if (terms === null) return z.NEVER;
    return {
      liabilityAccountId: data.liabilityAccountId,
      personName: data.personName,
      receivableAccountId: data.receivableAccountId,
      openingCents,
      openedOn: data.openedOn,
      ...terms,
    };
  });

export type SetUpThirdPartyCreditFields = z.input<typeof setUpThirdPartyCreditSchema>;
export type SetUpThirdPartyCreditInput = z.output<typeof setUpThirdPartyCreditSchema>;

export const updateThirdPartyCreditSchema = z
  .object({ liabilityAccountId: accountId("errors.notFound"), personName, ...lenderTerms })
  .transform((data, ctx) => {
    const terms = readLenderTerms(data, ctx);
    if (terms === null) return z.NEVER;
    return { liabilityAccountId: data.liabilityAccountId, personName: data.personName, ...terms };
  });

export type UpdateThirdPartyCreditFields = z.input<typeof updateThirdPartyCreditSchema>;
export type UpdateThirdPartyCreditInput = z.output<typeof updateThirdPartyCreditSchema>;

export const removeThirdPartyCreditSchema = z.object({ liabilityAccountId: accountId("errors.notFound") });

// RF-213: the payer's money arriving in a bank account of the person's: one transfer out of the receivable. The
// movement the query writes is then judged again by the transfer form's own schema.
export const recordThirdPartyPaymentSchema = z
  .object({
    liabilityAccountId: accountId("errors.notFound"),
    toAccountId: accountId("transactions.errors.accountInvalid"),
    amount: z.string(),
    occurredAt: occurredAtSchema,
    // Minted by the form when it opens: a submit sent again after a lost answer books once.
    requestRef: z.uuid({ error: "errors.unexpected" }).optional(),
  })
  .transform((data, ctx) => {
    const amountCents = checkPayment(data.amount, BASE_CURRENCY, ["amount"], ctx);
    if (amountCents === null) return z.NEVER;
    if (amountCents === 0) {
      ctx.addIssue({ code: "custom", message: "transactions.errors.amountInvalid", path: ["amount"] });
      return z.NEVER;
    }
    return { ...data, amountCents };
  });

export type RecordThirdPartyPaymentFields = z.input<typeof recordThirdPartyPaymentSchema>;
export type RecordThirdPartyPaymentInput = z.output<typeof recordThirdPartyPaymentSchema>;
