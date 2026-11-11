import { z } from "zod";

import { ActionError } from "@/lib/errors";
import { parseAmount } from "@/lib/money";

// Past the schema, a null parse can only be a schema that let something through.
export function requireMinor(amount: string): number {
  const minor = parseAmount(amount);
  if (minor === null) throw new ActionError("errors.unexpected");
  return minor;
}

// The refinement the form runs, run again against the currency the server read off the
// account rather than the one the payload claims (RNF-10). The first issue is what the
// caller is told.
export function assertRefined<T>(
  data: T,
  refine: (data: T, ctx: z.RefinementCtx) => void,
): void {
  const verdict = z.custom<T>().superRefine(refine).safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
}
