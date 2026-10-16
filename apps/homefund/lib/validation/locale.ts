import { z } from "zod";

import { LOCALES } from "@/lib/locales";

// The only gate on `app_users.locale`. The column is plain `text` — no enum and
// no check constraint — so this schema is the constraint, on the form and again
// on the server (RNF-10).
export const setLocaleSchema = z.object({
  locale: z.enum(LOCALES),
});

export type SetLocaleInput = z.infer<typeof setLocaleSchema>;
