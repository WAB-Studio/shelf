import { z } from "zod";

import { OFFERED_CURRENCIES } from "@/lib/currency";

// The two values `groups_cash_mode_valid` admits (RF-56); the group's id never
// travels, because RF-55 gives a user one group and the session resolves it.
export const GROUP_CASH_MODES = ["shared", "per_member"] as const;

// The name bound is `groups_name_length`'s, and the two message keys are the
// ones `createFundSchema` already uses: the same sentence, not a second key.
export const updateGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "fund.errors.nameRequired" })
    .max(80, { error: "fund.errors.nameTooLong" }),
  cashMode: z.enum(GROUP_CASH_MODES, { error: "group.errors.cashModeInvalid" }),
  // What the group reports in (RF-121); a switch to a shared cash mode seeds
  // its account settling here.
  currency: z.enum(OFFERED_CURRENCIES, { error: "group.errors.currencyInvalid" }),
});

export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
