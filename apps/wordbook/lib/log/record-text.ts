import { LOOKUP_SCHEMA, type LookupRecord } from "./types";

// The wire admits 500 characters per text field (`syncRowSchema`); a row
// recorded longer could never be sent.
export const RECORD_TEXT_MAX = 500;

/** Cuts to `RECORD_TEXT_MAX` code points, never splitting a surrogate pair. */
export function clampForRecord(text: string): string {
  let count = 0;
  let index = 0;
  while (index < text.length && count < RECORD_TEXT_MAX) {
    const code = text.codePointAt(index)!;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
}

// A key the caller left out stays out: only a present string is cut.
function clampAnswer(row: Pick<LookupRecord, "definition" | "exampleEn" | "exampleEs">) {
  const out: Pick<LookupRecord, "definition" | "exampleEn" | "exampleEs"> = {};
  for (const key of ["definition", "exampleEn", "exampleEs"] as const) {
    const value = row[key];
    if (value !== undefined) out[key] = value === null ? null : clampForRecord(value);
  }
  return out;
}

/** The row `recordLookup` holds until it settles: both texts cut to what the wire admits. */
export function pendingRowFrom(row: Omit<LookupRecord, "id" | "schema">): LookupRecord {
  return {
    ...row,
    text: clampForRecord(row.text),
    normalised: clampForRecord(row.normalised),
    ...clampAnswer(row),
    schema: LOOKUP_SCHEMA,
  };
}
