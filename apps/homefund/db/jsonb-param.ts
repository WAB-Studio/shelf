import { sql, type SQL } from "drizzle-orm";

// A set of records as ONE jsonb parameter for `jsonb_to_recordset` / `jsonb_array_elements_text`:
// Drizzle expands a JS array into a parenthesised list, never an array (docs/TRAPS.md).
export function jsonbParam(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}
