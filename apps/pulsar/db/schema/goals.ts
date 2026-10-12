import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";

// A name, a horizon and one measure. The measure itself is a sum over facts,
// never a column: these two only say what that sum is called and counted in.
export const goals = goalsSchema.table(
  "goals",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    name: text().notNull(),
    horizon: date().notNull(),
    // Null until the first commitment that measures something is created: the
    // new-goal screen asks for the name and the horizon alone.
    measureName: text(),
    measureUnit: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The plan's order among this person's own rows. A trigger fills it at insert when none is named; no UPDATE grant (RP-47).
    position: integer().notNull(),
    // Null while the goal is open. Set once, by `archiveGoal`, and cleared
    // once, by `reopenGoal` (RP-24) — never a second state beyond "set" and
    // "null": archiving is not a history, only a switch every open-goals
    // query filters on (`lib/queries/day.ts`, `lib/queries/week.ts`,
    // `lib/queries/goal.ts`'s own `listGoals`).
    archivedAt: timestamp({ withTimezone: true }),
    // Units a month the person plans at (RP-52); null falls back to the pace the plan derives.
    rhythm: integer(),
    // The month whose shift notice the person dismissed (RP-53), a first-of-month date.
    planSeen: date(),
    // The goal above (RP-78), three levels at most. No cascade: a goal that holds goals is never deleted
    // under them. The `goals.goals_guard_tree` trigger refuses a cycle, a fourth level and a horizon past
    // the parent's (RP-79), and a rhythm set on a goal that holds goals (RP-80).
    parentId: uuid().references((): AnyPgColumn => goals.id),
    // Plain text a person writes and changes at any time (RP-95); null when empty, never "".
    note: text(),
  },
  (t) => [
    // A measure with no unit is not a measure. Both null or both set.
    check(
      "goals_measure_paired",
      sql`(${t.measureName} is null) = (${t.measureUnit} is null)`,
    ),
    check(
      "goals_rhythm_range",
      sql`${t.rhythm} is null or (${t.rhythm} between 1 and 1000000 and ${t.measureUnit} is not null)`,
    ),
    check(
      "goals_plan_seen_first_day",
      sql`${t.planSeen} is null or ${t.planSeen} = date_trunc('month', ${t.planSeen})::date`,
    ),
    check("goals_not_own_parent", sql`${t.parentId} <> ${t.id}`),
    check(
      "goals_note_shape",
      sql`${t.note} is null or (char_length(${t.note}) between 1 and 20000 and ${t.note} ~ '\\S')`,
    ),
    index("goals_parent_id_idx").on(t.parentId),
    // `auth.uid()` bare, never `authUid`'s `(select auth.uid())`: the insert and update checks read
    // this table again, and Postgres refuses as infinite recursion (42P17) a self-read whose select
    // policy holds a subquery. The other policies keep `authUid`, evaluated once per query.
    pgPolicy("goals_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`auth.uid() = ${t.userId}`,
    }),
    pgPolicy("goals_insert_self", {
      for: "insert",
      to: authenticatedRole,
      // The FK alone would take another person's goal as the parent; under RLS `p` sees only the caller's.
      withCheck: sql`${authUid} = ${t.userId} and (${t.parentId} is null or exists (
        select 1 from "goals"."goals" p where p.id = ${t.parentId}
      ))`,
    }),
    // The grant narrows this to the measure pair; `using` alone would let a
    // caller hand their goal to someone else's id.
    pgPolicy("goals_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId} and (${t.parentId} is null or exists (
        select 1 from "goals"."goals" p where p.id = ${t.parentId}
      ))`,
    }),
  ],
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
