import { z } from "zod";

import { MAX_EXPORT_DAYS } from "@/lib/daily";
import { addDays, isCivilDay } from "@/lib/zone";

// The export's range (RT-15), one schema for the page's form and the download behind it.
export const exportRange = z
  .object({
    from: z.string().refine(isCivilDay),
    to: z.string().refine(isCivilDay),
  })
  .refine(({ from, to }) => from <= to && addDays(from, MAX_EXPORT_DAYS - 1) >= to);

export type ExportRange = z.infer<typeof exportRange>;

// Back to the form with the reason and the dates the person typed, so a bad range is fixed in place, not retyped.
export function rangeRetry(from: string | null, to: string | null): string {
  const query = new URLSearchParams({ error: "range" });
  if (from !== null && isCivilDay(from)) query.set("from", from);
  if (to !== null && isCivilDay(to)) query.set("to", to);
  return `/exportar?${query}`;
}

// The form's dates: the ones sent back with a bad range, else the defaults.
export function typedDay(value: string | undefined, fallback: string): string {
  return value !== undefined && isCivilDay(value) ? value : fallback;
}
