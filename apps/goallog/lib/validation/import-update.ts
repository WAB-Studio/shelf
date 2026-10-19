import { z } from "zod";

import { draftV2Schema } from "@/lib/import/draft";

const invalid = { error: "import.errors.draftInvalid" };

// A draft goal the review matched to one open goal, with the fingerprint of the differences it showed (RP-130).
const update = z.strictObject(
  {
    g: z.number(invalid).int(invalid).nonnegative(invalid),
    goalId: z.uuid(invalid),
    fingerprint: z.string(invalid),
  },
  invalid,
);

/**
 * What the review sends `confirmImport`: the draft and the goals it updates. A bare draft, as
 * every confirm before RP-130 sent, reads as one with no updates, so it creates every goal.
 */
export const importUpdateSchema = z.preprocess(
  (input) => (typeof input === "object" && input !== null && "draft" in input ? input : { draft: input, updates: [] }),
  z.strictObject({
    draft: draftV2Schema,
    updates: z.array(update, invalid).default([]),
    // A confirm resent after its answer was lost answers the first answer (RP-56).
    requestId: z.uuid(invalid).optional(),
  }),
);

export type ImportUpdate = z.infer<typeof update>;
export type ImportUpdateInput = z.infer<typeof importUpdateSchema>;
