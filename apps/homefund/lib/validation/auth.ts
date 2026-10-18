import { z } from "zod";

// The message is a catalogue key, not a sentence: the form translates it, and
// the server re-runs this exact schema on the same input (RNF-10).
export const signInSchema = z.object({
  // Trim and lowercase run before the format check, so a padded address passes.
  email: z
    .string({ error: "auth.errors.emailInvalid" })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "auth.errors.emailInvalid" })),
});

export type SignInInput = z.infer<typeof signInSchema>;

// RF-146: every whitespace goes first, so a code pasted as "123 456" is the six
// digits it shows; then exactly six digits.
export const signInCodeSchema = z.object({
  email: signInSchema.shape.email,
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, { error: "auth.errors.codeShape" })),
});

export type SignInCodeInput = z.infer<typeof signInCodeSchema>;
