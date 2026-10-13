import { todayInZone } from "@/lib/zone";

// An archived goal, or one whose horizon is today or behind it (never one with no end): it takes no
// new phase, commitment, month amount or task.
export function isClosed(goal: { horizon: string | null; archivedAt: Date | string | null }): boolean {
  return goal.archivedAt !== null || (goal.horizon !== null && goal.horizon <= todayInZone());
}
