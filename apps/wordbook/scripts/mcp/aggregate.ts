// Pure functions over an already-read `LookupRecord[]`. No IO here: `server.ts`
// owns the file and the protocol, so these run and are tested without a
// process, a socket or a stdin stream.
import type { LookupRecord } from "../../lib/log/types";

export type WordAggregate = {
  normalised: string;
  headword: string | null;
  count: number;
  lastAt: number;
  missRate: number;
};

function groupByWord(rows: readonly LookupRecord[]): Map<string, LookupRecord[]> {
  const groups = new Map<string, LookupRecord[]>();
  for (const row of rows) {
    const bucket = groups.get(row.normalised);
    if (bucket) bucket.push(row);
    else groups.set(row.normalised, [row]);
  }
  return groups;
}

// The headword named for a group is the most recent one a row actually
// reached; a run of misses before a later hit still surfaces the hit.
function aggregate(word: string, rows: readonly LookupRecord[]): WordAggregate {
  let lastAt = -Infinity;
  let headword: string | null = null;
  let headwordAt = -Infinity;
  let misses = 0;
  for (const row of rows) {
    if (row.at > lastAt) lastAt = row.at;
    if (row.outcome === "miss") misses += 1;
    if (row.headword !== null && row.at >= headwordAt) {
      headword = row.headword;
      headwordAt = row.at;
    }
  }
  return {
    normalised: word,
    headword,
    count: rows.length,
    lastAt,
    missRate: rows.length === 0 ? 0 : misses / rows.length,
  };
}

/**
 * The words most looked up, most frequent first, ties broken by the most
 * recent lookup. `sinceDays`, when given, drops every row older than that
 * many days from `now`; a word with no row left inside the window drops out
 * entirely rather than reporting a stale count.
 */
export function topWords(
  rows: readonly LookupRecord[],
  options: { limit: number; sinceDays?: number; now?: number },
): WordAggregate[] {
  const now = options.now ?? Date.now();
  const cutoff = options.sinceDays === undefined ? -Infinity : now - options.sinceDays * 86_400_000;
  const inWindow = rows.filter((row) => row.at >= cutoff);
  const groups = [...groupByWord(inWindow).entries()].map(([word, group]) => aggregate(word, group));
  groups.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return groups.slice(0, options.limit);
}

/** The words most recently looked up, most recent first. */
export function recentWords(rows: readonly LookupRecord[], options: { limit: number }): WordAggregate[] {
  const groups = [...groupByWord(rows).entries()].map(([word, group]) => aggregate(word, group));
  groups.sort((a, b) => b.lastAt - a.lastAt);
  return groups.slice(0, options.limit);
}

/** Every row a reader's log carries for one word, oldest first. */
export function wordHistory(rows: readonly LookupRecord[], word: string): LookupRecord[] {
  const target = word.trim().toLowerCase();
  return rows.filter((row) => row.normalised.toLowerCase() === target).sort((a, b) => a.at - b.at);
}
