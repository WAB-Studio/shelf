import { z } from "zod";

import { BASE_CURRENCY, OFFERED_CURRENCIES } from "@/lib/currency";
import { descriptionSchema, minorAmountSchema, occurredAtSchema } from "@/lib/validation/transaction";

export const MEMBER_DEBT_KINDS = ["debt", "payment"] as const;

const checkAmount = minorAmountSchema({
  required: "memberDebts.errors.amountRequired",
  invalid: "memberDebts.errors.amountInvalid",
  tooLarge: "memberDebts.errors.amountTooLarge",
});

// RF-183: one entry between two members of the fund, a debt or a payment of it. The form and the
// MCP send the amount as the decimal text a person types; the output carries it in integer cents.
export const recordMemberDebtSchema = z
  .object({
    kind: z.enum(MEMBER_DEBT_KINDS, { error: "errors.unexpected" }),
    debtorMemberId: z.uuid({ error: "memberDebts.errors.debtorRequired" }),
    creditorMemberId: z.uuid({ error: "memberDebts.errors.creditorRequired" }),
    amount: z.string(),
    currency: z.enum(OFFERED_CURRENCIES, { error: "memberDebts.errors.currencyInvalid" }).default(BASE_CURRENCY),
    occurredOn: occurredAtSchema,
    description: descriptionSchema.transform((value) => value || null),
  })
  .transform((data, ctx) => {
    if (data.debtorMemberId === data.creditorMemberId) {
      ctx.addIssue({ code: "custom", message: "memberDebts.errors.sameMember", path: ["creditorMemberId"] });
    }
    const amountCents = checkAmount(data.amount, data.currency, ["amount"], ctx);
    if (amountCents === null) return z.NEVER;
    if (amountCents === 0) {
      ctx.addIssue({ code: "custom", message: "memberDebts.errors.amountInvalid", path: ["amount"] });
      return z.NEVER;
    }
    return {
      kind: data.kind,
      debtorMemberId: data.debtorMemberId,
      creditorMemberId: data.creditorMemberId,
      amountCents,
      currency: data.currency,
      occurredOn: data.occurredOn,
      description: data.description,
    };
  });

export type RecordMemberDebtInput = z.output<typeof recordMemberDebtSchema>;

