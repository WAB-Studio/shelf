import { z } from "zod";

// The goal's own word for what it counts, once: the form of «Ponerle medida» and the AI door read this schema.
export const setGoalMeasureSchema = z.object(
  {
    goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
    name: z
      .string({ error: "plan.errors.nameEmpty" })
      .trim()
      .min(1, { error: "plan.errors.nameEmpty" })
      .max(120, { error: "plan.errors.nameTooLong" }),
    unit: z
      .string({ error: "plan.errors.unitEmpty" })
      .trim()
      .min(1, { error: "plan.errors.unitEmpty" })
      .max(40, { error: "plan.errors.unitTooLong" }),
  },
  { error: "plan.errors.goalInvalid" },
);

export type SetGoalMeasureInput = z.infer<typeof setGoalMeasureSchema>;
