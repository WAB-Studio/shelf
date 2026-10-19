import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { commitments } from "./commitments";
import { goalsSchema } from "./_schema";
import { goals } from "./goals";
import { oneOffs } from "./one-offs";

// Something that happened. Written once, removed whole or not at all: there is
// no UPDATE grant on this table to any role, and no update policy either.
export const facts = goalsSchema.table(
  "facts",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    commitmentId: uuid().references(() => commitments.id, {
      onDelete: "cascade",
    }),
    oneOffId: uuid().references(() => oneOffs.id, { onDelete: "cascade" }),
    goalId: uuid().references(() => goals.id, { onDelete: "cascade" }),
    // The day it happened, in the person's own zone, decided before the insert.
    day: date().notNull(),
    // The moment it was written, on the server's clock. Never the same column
    // as the day above, and never collapsed into it.
    writtenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    quantity: integer(),
    note: text(),
  },
  (t) => [
    // The day's screen reads one person's facts for one day.
    index("facts_user_id_day_idx").on(t.userId, t.day),
    index("facts_goal_id_day_idx").on(t.goalId, t.day),
    // A commitment holds at most one fact a day, whatever the device: a `tap`
    // row never doubles under two taps and a `quantity` row's "Cambiar"
    // deletes the old one first, so this is never in their way, only in a
    // race's. Partial on `commitment_id is not null`: a one-off's fact keeps
    // no such per-day limit.
    uniqueIndex("facts_commitment_day_unique")
      .on(t.commitmentId, t.day)
      .where(sql`${t.commitmentId} is not null`),
    // A one-off is done once: a second fact for it is refused whatever the
    // path (an action, the AI door, a race). A commitment keeps one per day.
    uniqueIndex("facts_one_off_unique")
      .on(t.oneOffId)
      .where(sql`${t.oneOffId} is not null`),
    // A line, not a journal entry.
    check("facts_note_length", sql`length(${t.note}) <= 280`),
    // Exactly one of the two, never both and never neither: a fact satisfies
    // something. A fact that belongs to nothing has no code asking for it.
    check(
      "facts_one_subject",
      sql`(${t.commitmentId} is null) <> (${t.oneOffId} is null)`,
    ),
    pgPolicy("facts_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    // A one-off holding sub-tasks is done by them, never by a fact of its own.
    // Each parent it names is one the caller sees under RLS; the aliases keep
    // the outer columns pointing at the new row.
    pgPolicy("facts_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and (${t.oneOffId} is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = ${t.oneOffId}
      )) and (${t.commitmentId} is null or exists (
        select 1 from "goals"."commitments" cm where cm.id = ${t.commitmentId}
      )) and (${t.oneOffId} is null or exists (
        select 1 from "goals"."one_offs" o where o.id = ${t.oneOffId}
      )) and (${t.goalId} is null or exists (
        select 1 from "goals"."goals" g where g.id = ${t.goalId}
      ))`,
    }),
    // Undoing a tap is a delete of the whole row: the only way a fact leaves.
    pgPolicy("facts_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
