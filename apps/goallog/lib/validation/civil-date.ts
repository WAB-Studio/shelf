import { z } from "zod";

import { isCivilDate } from "@/lib/zone";

// A real calendar day, or the caller's own refusal. The day is one the person named, never the server's clock.
export const civilDate = (message: string) => z.string().refine(isCivilDate, { error: message });
