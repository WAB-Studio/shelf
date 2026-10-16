import { z } from "zod";

import { setGoalMeasureSchema } from "./measure";

const goalId = z.uuid({ error: "plan.errors.goalInvalid" });

// Each act takes the goal alone; the form and the action read this one schema.
export const deleteGoalSchema = z.object({ goalId }, { error: "plan.errors.goalInvalid" });
export const removeGoalMeasureSchema = z.object({ goalId }, { error: "plan.errors.goalInvalid" });
export const removeRhythmSchema = z.object({ goalId }, { error: "plan.errors.goalInvalid" });

// A new measure is worded as the first one is (RP-117), so the same name and unit rules judge it.
export const changeGoalMeasureSchema = setGoalMeasureSchema;

export type DeleteGoalInput = z.infer<typeof deleteGoalSchema>;
export type ChangeGoalMeasureInput = z.infer<typeof changeGoalMeasureSchema>;
export type RemoveGoalMeasureInput = z.infer<typeof removeGoalMeasureSchema>;
export type RemoveRhythmInput = z.infer<typeof removeRhythmSchema>;
