import { boolean, text, timestamp } from "drizzle-orm/pg-core";

import { reading } from "./_schema";

// One row per headword the text route (RL-41, RL-42) has ever generated a
// definition or example for. Only an accepted model answer lands here: the
// route writes nothing on failure, so a bad day never blocks a retry. Not a
// reader's record — RLS is on with no policy, owner role only.
export const wordTexts = reading.table("word_texts", {
  headword: text().primaryKey(),
  definition: text(),
  exampleEn: text().notNull(),
  exampleEs: text().notNull(),
  model: text().notNull(),
  resolvedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // RL-45's network translations for a thin entry, cached beside the example:
  // null when never thin or never answered; an empty array is the model's
  // real "none", and closes the ask as surely as a list does.
  translations: text().array(),
  translationsAsked: boolean().notNull().default(false),
});

