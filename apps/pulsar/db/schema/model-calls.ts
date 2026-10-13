import { sql } from "drizzle-orm";
import { check, date, index, integer, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { TIME_ZONE } from "../../lib/zone";
import { goalsSchema } from "./_schema";

// One paid model call, claimed before it is made (RNP-13). The daily cap
// counts these rows; with no DELETE grant a person cannot lower their count.
export const modelCalls = goalsSchema.table(
  "model_calls",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // The person's day, never the caller's: no grant lets an insert name it.
    day: date()
      .notNull()
      .default(sql`(now() at time zone '${sql.raw(TIME_ZONE)}')::date`),
    calledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    model: text().notNull(),
    source: text().notNull(),
    // Null until the answer comes back.
    inputTokens: integer(),
    outputTokens: integer(),
    outcome: text(),
  },
  (t) => [
    index("model_calls_user_id_day_idx").on(t.userId, t.day),
    check("model_calls_source_known", sql`${t.source} in ('paste', 'file', 'chat')`),
    check("model_calls_input_tokens_non_negative", sql`${t.inputTokens} >= 0`),
    check("model_calls_output_tokens_non_negative", sql`${t.outputTokens} >= 0`),
    check(
      "model_calls_outcome_known",
      sql`${t.outcome} is null or ${t.outcome} in ('ok', 'failed', 'invalid', 'empty')`,
    ),
    pgPolicy("model_calls_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("model_calls_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    // The grant narrows this to the tokens and the outcome.
    pgPolicy("model_calls_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type ModelCall = typeof modelCalls.$inferSelect;
export type NewModelCall = typeof modelCalls.$inferInsert;
