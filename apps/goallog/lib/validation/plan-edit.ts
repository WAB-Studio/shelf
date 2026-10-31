import { z } from "zod";

import { cadenceSchema, phaseFields, phaseNotBackwards } from "./plan";

// The phase's own bounds are `addPhaseSchema`'s; only the key that names the row differs.
export const editPhaseSchema = z
  .object({ phaseId: z.uuid({ error: "plan.errors.phaseInvalid" }), ...phaseFields })
  .refine(phaseNotBackwards.check, phaseNotBackwards.params);

export type EditPhaseInput = z.infer<typeof editPhaseSchema>;

export const deletePhaseSchema = z.object(
  { phaseId: z.uuid({ error: "plan.errors.phaseInvalid" }) },
  { error: "plan.errors.phaseInvalid" },
);

export type DeletePhaseInput = z.infer<typeof deletePhaseSchema>;

const commitmentId = z.uuid({ error: "plan.errors.commitmentInvalid" });

// The cadence part of `addCommitmentSchema` with RP-12's bounds; what satisfies a commitment is not a field.
export const editCadenceSchema = z.intersection(z.object({ commitmentId }), cadenceSchema);

export type EditCadenceInput = z.infer<typeof editCadenceSchema>;

export const deleteCommitmentSchema = z.object({ commitmentId }, { error: "plan.errors.commitmentInvalid" });

export type DeleteCommitmentInput = z.infer<typeof deleteCommitmentSchema>;

// A commitment's name changes at any time: what the facts explain does not depend on it.
export const renameCommitmentSchema = z.object({
  commitmentId,
  name: z
    .string({ error: "plan.errors.nameEmpty" })
    .trim()
    .min(1, { error: "plan.errors.nameEmpty" })
    .max(120, { error: "plan.errors.nameTooLong" }),
});

export type RenameCommitmentInput = z.infer<typeof renameCommitmentSchema>;
