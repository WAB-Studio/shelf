import { z } from "zod";

import { ActionError } from "@/lib/errors";

// Claude speaks integer cents; the forms' schemas read the decimal text a person types. The text is
// built from the integer, so the schema then judges it exactly as it judges a form (RNF-10).
export function parseForm<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const verdict = schema.safeParse(data);
  if (!verdict.success) throw new ActionError(verdict.error.issues[0].message);
  return verdict.data;
}
