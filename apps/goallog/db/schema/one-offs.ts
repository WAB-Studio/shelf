import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
import { goals } from "./goals";

// Something to do once. No day when it is not on a day yet, no goal when it
// belongs to none: a one-off with neither is still a whole one-off.
export const oneOffs = goalsSchema.table(
  "one_offs",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    goalId: uuid().references(() => goals.id, { onDelete: "cascade" }),
    name: text().notNull(),
    day: date(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The plan's order among this person's own rows. A trigger fills it at insert when none is named; no UPDATE grant (RP-47).
    position: integer().notNull(),
    // In the goal's measure unit (RP-30). The sheet edits it (RP-55) until the task has a fact or children.
    estimate: integer(),
    // The fixed month (RP-51): null when the plan places the task. Written at insert and by the sheet's fix and unfix.
    plannedMonth: date(),
    // A task of the plan (RP-50), apart from a goal's suelta. A trigger sets it at insert when a month or a parent is named, or when a goal's row has no day; no UPDATE grant.
    inPlan: boolean().notNull().default(false),
    // One level deep (RP-30). No UPDATE grant: a sub-task never changes hands.
    parentId: uuid().references((): AnyPgColumn => oneOffs.id, { onDelete: "cascade" }),
    // Plain text a person writes and changes at any time (RP-45); null when empty, never "".
    note: text(),
  },
  (t) => [
    // Leading with `position` makes the fill-position `max` an index lookup.
    index("one_offs_user_id_position_idx").on(t.userId, t.position),
    index("one_offs_user_id_day_idx").on(t.userId, t.day),
    index("one_offs_goal_id_idx").on(t.goalId),
    index("one_offs_parent_id_idx").on(t.parentId),
    check("one_offs_estimate_range", sql`${t.estimate} between 1 and 1000000`),
    check(
      "one_offs_planned_month_first_day",
      sql`${t.plannedMonth} = date_trunc('month', ${t.plannedMonth})::date`,
    ),
    check("one_offs_planned_month_needs_goal", sql`${t.plannedMonth} is null or ${t.goalId} is not null`),
    check("one_offs_estimate_needs_goal", sql`${t.estimate} is null or ${t.goalId} is not null`),
    // A sub-task takes its parent's month.
    check("one_offs_child_has_no_month", sql`${t.parentId} is null or ${t.plannedMonth} is null`),
    check("one_offs_in_plan_shape", sql`not ${t.inPlan} or ${t.goalId} is not null`),
    check("one_offs_planned_month_in_plan", sql`${t.plannedMonth} is null or ${t.inPlan}`),
    check("one_offs_child_in_plan", sql`${t.parentId} is null or ${t.inPlan}`),
    check("one_offs_not_own_parent", sql`${t.parentId} <> ${t.id}`),
    check(
      "one_offs_note_shape",
      sql`${t.note} is null or (char_length(${t.note}) between 1 and 2000 and ${t.note} ~ '\\S')`,
    ),
    // `auth.uid()` bare, never `authUid`'s `(select auth.uid())`: the policies
    // below read this table again, and Postgres refuses as infinite recursion
    // any self-read whose select policy holds a subquery of its own (42P17).
    // The cost is one `auth.uid()` per row read instead of one per query.
    pgPolicy("one_offs_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`auth.uid() = ${t.userId}`,
    }),
    // A sub-task hangs only off an own top-level one-off in the plan
    // of the same goal, with no day, no estimate and no fact. Policies cannot
    // say row-to-row rules any other way; `p`'s alias keeps `${t.goalId}`
    // pointing at the new row, not at the parent. The goal, when named, is one
    // the caller sees under RLS: never someone else's, never one that exists nowhere.
    pgPolicy("one_offs_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and (${t.goalId} is null or exists (
        select 1 from "goals"."goals" g where g.id = ${t.goalId}
      )) and (${t.parentId} is null or exists (
        select 1 from "goals"."one_offs" p
        where p.id = ${t.parentId} and p.parent_id is null and p.in_plan
          and p.day is null and p.estimate is null and p.goal_id = ${t.goalId}
          and not exists (select 1 from "goals"."facts" f where f.one_off_id = p.id)
      ))`,
    }),
    // RP-22: a one-off that already carries a fact is never deleted, by
    // whatever door reaches this row — the policy is the enforcement, not
    // `deleteOneOff`'s own check alone (driven bare, under a settled
    // session with no server action in the way, a weaker policy let the row
    // go and the fact cascaded with it). The subquery
    // runs under the caller's own RLS on `goals.facts`
    // (`facts_select_self`): a person's own fact is always visible to them
    // there, so this never passes vacuously for the row it is meant to
    // guard — never `"goals".facts` through the `facts` table object,
    // which would close an import cycle back to this file.
    // A parent whose sub-task carries a fact stays too: the FK cascade to its
    // children bypasses RLS, so this is the only place the child's fact is kept.
    pgPolicy("one_offs_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId} and not exists (
        select 1 from "goals"."facts" f where f.one_off_id = ${t.id}
      ) and not exists (
        select 1 from "goals"."one_offs" c join "goals"."facts" f on f.one_off_id = c.id
        where c.parent_id = ${t.id}
      )`,
    }),
    // `using` is the own row alone: a note reaches a done or past-dated row.
    // RP-59's rule (a day after the person's today, no fact) moved to the
    // `goals.one_offs_guard_day` trigger, which skips the row when `day` or
    // `planned_month` changes on a row the rule refuses — 0 rows, as before.
    pgPolicy("one_offs_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      // A parent never takes a day, and still takes a month. In `withCheck`,
      // never in `using`: there it would refuse the shift's move of a parent.
      withCheck: sql`${authUid} = ${t.userId} and (${t.day} is null or not exists (
        select 1 from "goals"."one_offs" c where c.parent_id = ${t.id}
      ))`,
    }),
  ],
);

export type OneOff = typeof oneOffs.$inferSelect;
export type NewOneOff = typeof oneOffs.$inferInsert;
