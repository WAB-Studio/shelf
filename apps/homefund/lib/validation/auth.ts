import { z } from "zod";

// The message is a catalogue key, not a sentence: the form translates it, and
// the server re-runs this exact schema on the same input (RNF-10).
export const signInSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }).trim().toLowerCase(),
});

export type SignInInput = z.infer<typeof signInSchema>;
