import { z } from "zod";

import { MONTH_PATTERN, todayInBogota } from "@/lib/dates";

// A `?month=` parameter: a real `YYYY-MM`, or the current Bogotá month when it is missing or
// malformed, so a screen's window always resolves. The shape alone is not enough: `1999-13-01`
// is no day, and `monthRange` throws on it before any bound reaches Postgres.
export const monthParamSchema = z
  .string()
  .regex(MONTH_PATTERN)
  .catch(() => todayInBogota().slice(0, 7));
