import { z } from "zod";

import { OFFERED_CURRENCIES } from "@/lib/currency";

// Messages are catalogue keys, not sentences: the form translates them, and
// the server re-runs these exact schemas on the same input (RNF-10).
export const createFundSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "fund.errors.nameRequired" })
    .max(80, { error: "fund.errors.nameTooLong" }),
  memberName: z
    .string()
    .trim()
    .min(1, { error: "fund.errors.memberNameRequired" })
    .max(80, { error: "fund.errors.memberNameTooLong" }),
  // What the fund settles in (RF-121); the group and its seeded cash account
  // both inherit it. The one message key `updateGroupSchema` also uses — the
  // same sentence, not a second one.
  currency: z.enum(OFFERED_CURRENCIES, { error: "group.errors.currencyInvalid" }),
});

export type CreateFundInput = z.infer<typeof createFundSchema>;
