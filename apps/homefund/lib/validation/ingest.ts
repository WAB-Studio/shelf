import { z } from "zod";

import {
  refineSplits,
  requireAnAccount,
  transactionFields,
} from "@/lib/validation/transaction";

// Accepting is the movement form's own payload with the delivery in place of
// the transaction, so the prefilled form and the action run one schema (RNF-10)
// and the account, split and date rules hold as on a manual write. The
// delivery's `externalRef` rides inside the shared fields and the action drops
// it: the reference the movement stores is the one the queue already holds.
export const acceptDeliverySchema = z
  .object({
    deliveryId: z.uuid({ error: "ingest.errors.deliveryInvalid" }),
    ...transactionFields,
  })
  .superRefine(requireAnAccount)
  .superRefine(refineSplits);

export type AcceptDeliveryInput = z.infer<typeof acceptDeliverySchema>;

// Silencing rides on the rejection instead of standing alone: a shape is
// silenced only by rejecting a delivery shaped like it (RF-92).
export const rejectDeliverySchema = z.object({
  deliveryId: z.uuid({ error: "ingest.errors.deliveryInvalid" }),
  silenceShape: z.boolean(),
});

export type RejectDeliveryInput = z.infer<typeof rejectDeliverySchema>;

// The only way out of `ambiguous`, so a merchant that was learned wrong can be
// learned again from scratch (RF-94).
export const forgetMerchantSchema = z.object({
  merchantId: z.uuid({ error: "ingest.errors.merchantInvalid" }),
});

export type ForgetMerchantInput = z.infer<typeof forgetMerchantSchema>;

// Undoing a silence (RF-99): dropping the memory returns the shape to *never
// seen*, which RF-92 lets wait for review again, and returns with it the
// deliveries that memory discarded on its own.
export const restoreShapeSchema = z.object({
  shapeId: z.uuid({ error: "ingest.errors.shapeInvalid" }),
});

export type RestoreShapeInput = z.infer<typeof restoreShapeSchema>;
