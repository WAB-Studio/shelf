import { unreadableSources } from "./fault-seam";
import { readReadingLookups } from "./reading-lookups";
import type { EvidenceReader } from "./types";

/**
 * Every source a commitment can point at, keyed by `goals.evidence_sources
 * .key` (RP-07). A second source is one entry here plus one seeded row in
 * that table, never a migration and never a screen (RNP-10).
 */
const READERS: Record<string, EvidenceReader> = {
  reading_lookups: readReadingLookups,
};

// Read per call, never at import: the seam is a property of the process a
// test starts, and `next.config.ts` refuses a build that carries it on Vercel.
export function readerFor(key: string): EvidenceReader | null {
  if (unreadableSources(process.env.PULSAR_FAULT_SEAM, process.env.VERCEL).has(key)) {
    return async () => {
      throw new Error(`PULSAR_FAULT_SEAM: ${key} unreadable`);
    };
  }
  return READERS[key] ?? null;
}

// Every key a day, week or goal query has to fan `withReadingDb` out over,
// in the order `READERS` declares them — the one list RNP-10 lets a second
// source cost, instead of a copy edited in each of the three query files.
export function knownSourceKeys(): readonly string[] {
  return Object.keys(READERS);
}
