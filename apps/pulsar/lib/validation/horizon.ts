import { z } from "zod";

import { isCivilDate } from "@/lib/zone";

export const moveHorizonSchema = z.object({
  goalId: z.uuid({ error: "plan.errors.goalInvalid" }),
  horizon: z.string().refine(isCivilDate, { error: "plan.errors.horizonInvalid" }),
  // Also gives the new end to every goal under it that ends later (RP-79).
  moveBranch: z.boolean().optional(),
});

export type MoveHorizonInput = z.infer<typeof moveHorizonSchema>;

export type HorizonRefusal = "goal.errors.horizonPast" | "goal.errors.horizonBeforePhase";

// The mirror of `phaseWithinHorizon`: a horizon is the first day after the
// goal, so it must be after today, and no phase may end past it. Pure, so the
// client runs the same rule before the round trip.
export function horizonRefusal({
  horizon,
  today,
  lastPhaseEndsOn,
}: {
  horizon: string;
  today: string;
  lastPhaseEndsOn: string | null;
}): HorizonRefusal | null {
  if (horizon <= today) return "goal.errors.horizonPast";
  if (lastPhaseEndsOn != null && lastPhaseEndsOn > horizon) return "goal.errors.horizonBeforePhase";
  return null;
}
