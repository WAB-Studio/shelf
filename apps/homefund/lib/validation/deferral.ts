import { z } from "zod";

import { MAX_INSTALMENTS, MIN_INSTALMENTS } from "@/lib/deferral";

// RF-136: how many monthly instalments a purchase was deferred into. A person confirms the count;
// the app never concludes it.
export const instalmentsSchema = z
  .number({ error: "deferrals.errors.instalmentsInvalid" })
  .int({ error: "deferrals.errors.instalmentsInvalid" })
  .min(MIN_INSTALMENTS, { error: "deferrals.errors.instalmentsInvalid" })
  .max(MAX_INSTALMENTS, { error: "deferrals.errors.instalmentsInvalid" });

export const deferPurchaseSchema = z.object({
  transactionId: z.uuid({ error: "errors.unexpected" }),
  instalments: instalmentsSchema,
});

export const undeferPurchaseSchema = z.object({
  transactionId: z.uuid({ error: "errors.unexpected" }),
});

export type DeferPurchaseInput = z.infer<typeof deferPurchaseSchema>;
