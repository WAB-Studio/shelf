import { z } from "zod";

// What a tool's input refusal needs from the catalogue: the pieces of a reason, with their values.
export type Say = (key: string, values?: Record<string, string>) => string;
// A message that is itself a catalogue key (a form schema's own refusal) read as its sentence, or undefined.
export type Known = (message: string) => string | undefined;

const KEY = /^[A-Za-z]+(\.[A-Za-z0-9]+)+$/;
const TYPES = new Set(["string", "number", "int", "boolean", "array", "object"]);
const FORMATS = new Set(["uuid", "date"]);

// The reason an input fails, in the person's language: a schema's own catalogue message stands alone;
// any other is a piece of `mcp.errors.input` read after the field's name.
function reasonOf(issue: z.core.$ZodIssue, say: Say, known: Known): { text: string; standalone: boolean } {
  const own = KEY.test(issue.message) ? known(issue.message) : undefined;
  if (own !== undefined) return { text: own, standalone: true };
  const reason = (key: string, values?: Record<string, string>) => ({ text: say(`errors.input.${key}`, values), standalone: false });
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? reason("required") : reason(`type.${TYPES.has(issue.expected) ? issue.expected : "other"}`);
    case "invalid_format":
      return reason(`format.${FORMATS.has(issue.format) ? issue.format : "other"}`);
    case "too_small":
      return reason(`tooSmall.${issue.origin === "array" || issue.origin === "string" ? issue.origin : "number"}`, { min: String(issue.minimum) });
    case "too_big":
      return reason(`tooBig.${issue.origin === "array" || issue.origin === "string" ? issue.origin : "number"}`, { max: String(issue.maximum) });
    case "invalid_value":
      return reason("oneOf", { values: issue.values.map(String).join(", ") });
    case "unrecognized_keys":
      return reason("unknownKeys", { keys: issue.keys.join(", ") });
    default:
      return reason("invalid");
  }
}

/** One sentence per failed field, «requestRef debe ser un UUID», and the first field apart. */
export function describeIssues(issues: readonly z.core.$ZodIssue[], say: Say, known: Known): { error: string; field?: string } {
  const sentences = issues.map((issue) => {
    const field = issue.path.map(String).join(".");
    const { text, standalone } = reasonOf(issue, say, known);
    return standalone || field === "" ? text : `${field} ${text}`;
  });
  const field = issues[0]?.path.map(String).join(".");
  return { error: [...new Set(sentences)].join("; "), ...(field ? { field } : {}) };
}

// The text the protocol hands the client as the tool's answer: the same `{ error }` JSON every other refusal is.
export class InputRefusal extends Error {}

/** Reads a tool's arguments with its schema; a failure names each field and why, in the catalogue's words. */
export async function readInput(schema: z.ZodType, args: unknown, say: Say, known: Known): Promise<unknown> {
  const verdict = await schema.safeParseAsync(args ?? {}, { reportInput: true });
  if (verdict.success) return verdict.data;
  throw new InputRefusal(JSON.stringify(describeIssues(verdict.error.issues, say, known)));
}
