import { readAll } from "./record";
import { LOOKUP_SCHEMA, type LookupRecord } from "./types";

// The wrapper's own version, separate from `LOOKUP_SCHEMA`: the file format
// can gain a field around the rows without the rows' own schema moving.
export const EXPORT_SCHEMA = 1;

export type LogExport = {
  exportSchema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  recordSchema: typeof LOOKUP_SCHEMA;
  rows: LookupRecord[];
};

/**
 * Reads the whole log and wraps it with what a later import needs to know
 * about its shape (RL-20). Read-only: no row is touched, and nothing here
 * reaches into `lib/dictionary` — this runs on a screen the word path never
 * mounts (RNL-08).
 */
export async function buildExport(): Promise<LogExport> {
  const rows = await readAll();
  return {
    exportSchema: EXPORT_SCHEMA,
    exportedAt: Date.now(),
    recordSchema: LOOKUP_SCHEMA,
    rows,
  };
}
