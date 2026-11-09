import { z } from "zod";

// Shared with the route handler and the client that calls it, so the body a
// `fetch` sends is exactly the body the handler accepts. Loaded by client
// components too, so no `server-only` here (docs/TRAPS.md, "server-only
// resolves under Next and nowhere else").

export const UNLISTED_ENDPOINT = "/api/word/unlisted";

// One field, on purpose: the server derives lemma, rule and every other fact
// from its own dictionary index, so there is nothing here a caller can lie
// about (RL-86's contract).
export const unlistedRequestSchema = z.object({
  word: z.string().min(1).max(64),
  // The reader's own tap on «Buscar en internet» for a word one edit from a headword (RL-86); without it
  // the server asks the model nothing for such a word.
  confirmed: z.literal(true).optional(),
});

export const unlistedResponseSchema = z.object({
  translations: z.array(z.string().min(1)).min(1),
  definition: z.string().min(1).nullable(),
  // Both null for a word the dictionary carries no trace of at all, both set
  // when the word is a form `lookupWord` traced back to a lemma it does have.
  lemma: z.string().min(1).nullable(),
  rule: z.string().min(1).nullable(),
});
export type UnlistedAnswer = z.infer<typeof unlistedResponseSchema>;
