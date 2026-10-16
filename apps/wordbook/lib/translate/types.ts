import { z } from "zod";

// Which path answered a sentence, so the interface can say so (RL-09).
export type TranslationOrigin = "device" | "network";

export type TranslationResult = {
  text: string;
  origin: TranslationOrigin;
};

// The body `network.ts` sends and `app/api/translate/route.ts` accepts — one
// schema, not two hand-kept in sync. Here, not in the route: the route
// imports the database, and the client must never bundle it.
export const translateRequestSchema = z.object({
  text: z.string().min(1).max(1000),
});
