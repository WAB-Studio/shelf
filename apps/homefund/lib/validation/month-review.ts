import { z } from "zod";

import { REVIEW_RULES } from "@/lib/month-review-rules";

// «Está bien» on one item of «Revisar el mes» (RF-155): every movement the item names, one rule.
export const markReviewedSchema = z.object({
  transactionIds: z.array(z.uuid({ error: "errors.unexpected" })).min(1).max(500),
  rule: z.enum(REVIEW_RULES),
});

export type MarkReviewedInput = z.infer<typeof markReviewedSchema>;
