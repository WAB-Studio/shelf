import { z } from "zod";

export const signInEmailSchema = z.email();

// RP-136: whitespace out first, so a code pasted as «123 456» passes; then exactly six ASCII digits.
export const signInCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^\d{6}$/));
