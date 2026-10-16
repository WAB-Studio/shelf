import type { LookupOutcome } from "./types";

export const RECORDED_OUTCOMES: readonly LookupOutcome[] = ["exact", "inflected", "translated", "unlisted"];

export function isRecordedOutcome(outcome: LookupOutcome): boolean {
  return RECORDED_OUTCOMES.includes(outcome);
}
