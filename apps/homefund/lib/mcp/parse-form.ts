import { z } from "zod";

import { ActionError } from "@/lib/errors";

// Claude speaks integer cents; the forms' schemas read the decimal text a person types. The text is
// built from the integer, so the schema then judges it exactly as it judges a form (RNF-10).
export function parseForm<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const verdict = schema.safeParse(data);
  if (!verdict.success) {
    const [issue] = verdict.error.issues;
    throw new ActionError(issue.message, undefined, fieldOf(issue.path));
  }
  return verdict.data;
}

// The form's decimal fields are the tool's cents: Claude is told the name it sent, not the form's.
const TOOL_NAMES: Record<string, string> = { amount: "amountCents", counterAmount: "counterAmountCents", realAmount: "realAmountCents" };

function fieldOf(path: readonly PropertyKey[]): string | undefined {
  if (path.length === 0) return undefined;
  const [first, ...rest] = path.map(String);
  return [TOOL_NAMES[first] ?? first, ...rest].join(".");
}
