import { readCards, readSenseChoices, type SenseChoice } from "../review/store";
import type { ReviewCard } from "../review/schedule";
import { readAll } from "./record";
import { LOOKUP_SCHEMA, type LookupRecord } from "./types";

// The wrapper's own version, separate from `LOOKUP_SCHEMA`: the file format
// can gain a field around the rows without the rows' own schema moving.
//
// 1: `exportedAt`, `recordSchema` and `rows`.
// 2 (RL-95): version 1 plus `review`, the review's cards and the senses the reader tapped. Nothing of version 1
//    moved, so a reader that knows only version 1 finds what it read before; a file of version 1 has no `review`
//    and reads as a record with no review.
export const EXPORT_SCHEMA = 2;

export type LogExport = {
  exportSchema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  recordSchema: typeof LOOKUP_SCHEMA;
  rows: LookupRecord[];
  review: { cards: ReviewCard[]; senses: SenseChoice[] };
};

/**
 * Reads the whole log and the review's state, and wraps them with what a later import needs to know
 * about their shape (RL-20, RL-95). Read-only: nothing is touched, and nothing here
 * reaches into `lib/dictionary` — this runs on a screen the word path never
 * mounts (RNL-08).
 */
export async function buildExport(): Promise<LogExport> {
  const [rows, cards, senses] = await Promise.all([readAll(), readCards(), readSenseChoices()]);
  return {
    exportSchema: EXPORT_SCHEMA,
    exportedAt: Date.now(),
    recordSchema: LOOKUP_SCHEMA,
    rows,
    review: { cards, senses },
  };
}
