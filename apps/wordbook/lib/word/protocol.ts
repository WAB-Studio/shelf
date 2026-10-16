import { z } from "zod";

export const textRequestSchema = z.object({
  headword: z.string().min(1).max(64),
  needDefinition: z.boolean(),
});

export const textResponseSchema = z.object({
  definition: z.string().min(1).nullable(),
  example: z.object({
    en: z.string().min(1),
    es: z.string().min(1),
  }),
  // RL-45: null for an answer the dictionary was never thin on. A thin one
  // asked over the network answers an array — empty if none came back — and
  // is never asked again (`word-texts.ts`'s `translationsAsked`).
  // Absent parses as null rather than throwing: `use-decoration.ts` parses
  // with `.parse`, so a body cached before this field existed would take the
  // generated text down with it.
  translations: z.array(z.string().min(1)).nullable().default(null),
});
export type WordText = z.infer<typeof textResponseSchema>;

export const TEXT_ENDPOINT = "/api/word/text";
