import type { LookupOutcome, LookupRecord } from "./types";

export const RECORDED_OUTCOMES: readonly LookupOutcome[] = ["exact", "inflected", "translated", "unlisted"];

type Gated = Pick<LookupRecord, "schema" | "kind" | "outcome" | "device">;

/**
 * RL-76: a row this device recorded that waits for the network — a word with
 * no entry or a sentence the translator would have taken. A `miss` older than
 * schema 4 never was, and a row another device recorded is never this one's
 * to ask.
 */
export function isPendingLookup(row: Gated): boolean {
  if (row.schema < 4 || row.device != null) return false;
  return (row.outcome === "miss" && row.kind === "word") || (row.outcome === "untranslated" && row.kind === "phrase");
}

/** Whether a settled lookup leaves a row: answered, or pending. */
export function isRecordedLookup(row: Gated): boolean {
  return RECORDED_OUTCOMES.includes(row.outcome) || isPendingLookup(row);
}

/** A study row is a phrase when its newest answer is a sentence's: answered or still waiting. */
export function isPhraseRow(row: { lastOutcome: LookupOutcome }): boolean {
  return row.lastOutcome === "translated" || row.lastOutcome === "untranslated";
}

/** The word the interface uses for a count of rows: «entradas» once a phrase is among them. */
export function countKind(rows: readonly { lastOutcome: LookupOutcome }[]): "entries" | "words" {
  return rows.some(isPhraseRow) ? "entries" : "words";
}
