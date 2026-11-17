import { z } from "zod";

import { isCurrencyCode } from "@/lib/currency";
import { isCivilDate } from "@/lib/dates";
import { maxAmountMinor } from "@/lib/money";
import { rateSchema } from "@/lib/validation/debt-terms";

// What a card statement carries beyond its own closing figures and the terms (RF-254): the deferrals it
// lists and the purchases it shows. The statement itself and the terms keep their own schemas.
export const MAX_CARD_DEFERRALS = 50;
export const MAX_CARD_PURCHASES = 300;

const currencySchema = z.string().refine(isCurrencyCode, { error: "cardStatement.errors.currencyInvalid" });

const cents = (key: string) => z.number({ error: key }).int({ error: key });

// A bank's authorization number, kept as it prints it: the key a later statement finds the deferral by.
const authorizationSchema = z
  .string({ error: "cardStatement.errors.authorizationInvalid" })
  .trim()
  .min(1, { error: "cardStatement.errors.authorizationInvalid" })
  .max(40, { error: "cardStatement.errors.authorizationInvalid" });

export const cardDeferralSchema = z
  .object({
    authorizationNumber: authorizationSchema,
    description: z
      .string({ error: "cardStatement.errors.descriptionInvalid" })
      .trim()
      .min(1, { error: "cardStatement.errors.descriptionInvalid" })
      .max(200, { error: "cardStatement.errors.descriptionInvalid" }),
    currency: currencySchema,
    originalAmountCents: cents("cardStatement.errors.amountInvalid").min(1, { error: "cardStatement.errors.amountInvalid" }),
    instalments: cents("cardStatement.errors.instalmentsInvalid")
      .min(1, { error: "cardStatement.errors.instalmentsInvalid" })
      .max(120, { error: "cardStatement.errors.instalmentsInvalid" }),
    currentInstalment: cents("cardStatement.errors.currentInstalmentInvalid").min(1, {
      error: "cardStatement.errors.currentInstalmentInvalid",
    }),
    monthlyInstalmentCents: cents("cardStatement.errors.amountInvalid").min(0, { error: "cardStatement.errors.amountInvalid" }),
    pendingBalanceCents: cents("cardStatement.errors.amountInvalid").min(0, { error: "cardStatement.errors.amountInvalid" }),
    // The percentage the statement prints, "28.1", as the debt terms read one.
    annualRatePct: rateSchema({ required: "debts.errors.rateRequired", invalid: "debts.errors.rateInvalid" }),
  })
  .superRefine((deferral, ctx) => {
    if (deferral.currentInstalment > deferral.instalments) {
      ctx.addIssue({ code: "custom", message: "cardStatement.errors.currentInstalmentInvalid", path: ["currentInstalment"] });
    }
    // A currency the runtime does not know already failed above and names no scale.
    if (!isCurrencyCode(deferral.currency)) return;
    const ceiling = maxAmountMinor(deferral.currency);
    for (const key of ["originalAmountCents", "monthlyInstalmentCents", "pendingBalanceCents"] as const) {
      if (deferral[key] > ceiling) ctx.addIssue({ code: "custom", message: "cardStatement.errors.amountInvalid", path: [key] });
    }
  });

export const cardPurchaseSchema = z
  .object({
    occurredOn: z.string().refine(isCivilDate, { error: "cardStatement.errors.dateInvalid" }),
    amountCents: cents("cardStatement.errors.amountInvalid").min(1, { error: "cardStatement.errors.amountInvalid" }),
    currency: currencySchema,
    description: z.string().max(200, { error: "cardStatement.errors.descriptionInvalid" }).nullish(),
  })
  .superRefine((purchase, ctx) => {
    if (isCurrencyCode(purchase.currency) && purchase.amountCents > maxAmountMinor(purchase.currency)) {
      ctx.addIssue({ code: "custom", message: "cardStatement.errors.amountInvalid", path: ["amountCents"] });
    }
  });

export const cardStatementExtrasSchema = z
  .object({
    deferrals: z.array(cardDeferralSchema).max(MAX_CARD_DEFERRALS, { error: "cardStatement.errors.tooMany" }),
    purchases: z.array(cardPurchaseSchema).max(MAX_CARD_PURCHASES, { error: "cardStatement.errors.tooMany" }),
  })
  .superRefine((extras, ctx) => {
    const seen = new Set<string>();
    extras.deferrals.forEach((deferral, index) => {
      if (seen.has(deferral.authorizationNumber)) {
        ctx.addIssue({ code: "custom", message: "cardStatement.errors.authorizationRepeated", path: ["deferrals", index] });
      }
      seen.add(deferral.authorizationNumber);
    });
  });

export type CardDeferralInput = z.infer<typeof cardDeferralSchema>;
export type CardPurchaseInput = z.infer<typeof cardPurchaseSchema>;
