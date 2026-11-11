import { z } from "zod";

// «Siempre» is the default and the only choice that never signs a device out; each other
// choice is the days a device may sit unused before it does (RF-190).
export const KEEP_SIGNED_IN_CHOICES = ["always", "7", "30", "90", "180"] as const;

export type KeepSignedInChoice = (typeof KEEP_SIGNED_IN_CHOICES)[number];

// The gate on `user_metadata.keep_signed_in_days`, on the form and again on the server (RNF-10).
export const keepSignedInSchema = z.object({
  days: z.enum(KEEP_SIGNED_IN_CHOICES, { error: "errors.unexpected" }),
});

export type KeepSignedInInput = z.infer<typeof keepSignedInSchema>;

/** The stored value for a choice: whole days, or `null` for «Siempre». */
export function keepDaysOf(choice: KeepSignedInChoice): number | null {
  return choice === "always" ? null : Number(choice);
}

export function isKeepSignedInChoice(value: string): value is KeepSignedInChoice {
  return (KEEP_SIGNED_IN_CHOICES as readonly string[]).includes(value);
}

/** The form value of a stored limit; a number nobody offers keeps its own value, never «Siempre». */
export function choiceOfDays(days: number | null): string {
  return days === null ? "always" : String(days);
}
