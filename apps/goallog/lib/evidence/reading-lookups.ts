import { sharedRows } from "./shared-read";
import type { EvidenceReader } from "./types";

/**
 * One search, one row: `Meta.dc.html` draws «1 búsqueda · diccionario», so a day's quantity is a plain count.
 */
const UNIT = "searches";
const LABEL_KEY = "sources.readingLookups";

/**
 * Rides `shared-read.ts`'s one statement. Nothing here filters by `personId` —
 * `apps/wordbook`'s own `lookups_select_self` policy narrows `reading.lookups`
 * (apps/wordbook/db/schema/lookups.ts) to the caller's own (RP-10, RNP-05),
 * because `tx` arrives settled to `role = authenticated` by `withReadingDb`.
 */
export const readReadingLookups: EvidenceReader = async ({ from, to, zone, tx }) => {
  const { searches } = await sharedRows(tx, from, to, zone);
  return searches.map((row) => ({
    day: row.day,
    quantity: row.quantity,
    unit: UNIT,
    labelKey: LABEL_KEY,
  }));
};
