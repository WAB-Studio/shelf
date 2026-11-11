import { z } from "zod";

import { MONTH_PATTERN, todayInBogota } from "@/lib/dates";

// A `?month=` parameter: a real `YYYY-MM`, or the current Bogotá month when it is missing or malformed.
export const monthParamSchema = z
  .string()
  .regex(MONTH_PATTERN)
  .catch(() => todayInBogota().slice(0, 7));
