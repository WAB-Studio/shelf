import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { UnlistedAnswer } from "@/lib/word/unlisted-protocol";

type CachedRow = {
  lemma: string | null;
  rule: string | null;
  translations: string[];
  definition: string | null;
};

/** The one round trip the hot path pays. A miss returns `null`, never throws. */
export async function readCachedAnswer(word: string): Promise<UnlistedAnswer | null> {
  const [row] = await db.execute<CachedRow>(sql`
    select lemma, rule, translations, definition
    from reading.word_answers
    where word = ${word}
  `);
  if (!row) return null;
  return {
    translations: row.translations,
    definition: row.definition,
    lemma: row.lemma,
    rule: row.rule,
  };
}

/**
 * `example_en` and `example_es` stay NOT NULL on rows written before examples were retired; new rows leave them empty.
 *
 * Written once, on an accepted model answer alone (`writeCachedText`'s same
 * rule): a failure leaves no row, so the daily cap is what bounds a word
 * that keeps failing, never a bad row on disk. `on conflict do nothing`: two
 * cold readers racing the same word both pay the call, and whichever insert
 * lands first is the one every later reader sees.
 *
 * `translations` cannot be bound as a bare array parameter — drizzle expands
 * a JS array inside a `sql` template into a parenthesised comma list, not a
 * Postgres array literal (docs/TRAPS.md, "An array binding is not an
 * array") — so it is built as an explicit `ARRAY[...]::text[]` instead.
 */
export async function writeCachedAnswer(
  word: string,
  lemma: string | null,
  rule: string | null,
  translations: readonly string[],
  definition: string | null,
  model: string,
): Promise<void> {
  const translationsArray = sql`ARRAY[${sql.join(
    translations.map((translation) => sql`${translation}`),
    sql`, `,
  )}]::text[]`;
  await db.execute(sql`
    insert into reading.word_answers
      (word, lemma, rule, translations, definition, example_en, example_es, model)
    values
      (${word}, ${lemma}, ${rule}, ${translationsArray}, ${definition}, '', '', ${model})
    on conflict (word) do nothing
  `);
}
