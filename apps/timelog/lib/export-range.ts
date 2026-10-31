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
