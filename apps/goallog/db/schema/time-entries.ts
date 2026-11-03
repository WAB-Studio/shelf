import { sql } from "drizzle-orm";
import { check, date, index, integer, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { goalsSchema } from "./_schema";
import { goals } from "./goals";
import { oneOffs } from "./one-offs";

// Time that arrived without the person placing it (RP-151): a task's clock, the chat, TimeLog. It waits here and
// adds to no goal until `time_allocations` gives it one. Granted per column: `user_id`, `day` and `minutes` are
// written at insert, `minutes` again while no allocation holds it, `dismissed_at` by «no cuenta» and its undo.
export const timeEntries = goalsSchema.table(
  "time_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    day: date().notNull(),
    minutes: integer().notNull(),
    source: text().notNull(),
    // The task the time came from. A task deleted leaves its time where it was told: it is the person's, not the task's.
    oneOffId: uuid().references(() => oneOffs.id, { onDelete: "set null" }),
    // Where the source thinks it goes; the person may give it elsewhere.
    suggestedGoalId: uuid().references(() => goals.id, { onDelete: "set null" }),
    note: text(),
    // «No cuenta» (RP-151): the entry adds to no goal and leaves the tray.
    dismissedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("time_entries_user_id_day_idx").on(t.userId, t.day),
    index("time_entries_one_off_id_idx").on(t.oneOffId),
    check("time_entries_minutes_range", sql`${t.minutes} between 1 and 1000000`),
    check("time_entries_source_known", sql`${t.source} in ('task', 'chat', 'timelog')`),
    check("time_entries_note_shape", sql`${t.note} is null or char_length(${t.note}) between 1 and 280`),
    pgPolicy("time_entries_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    // The task and the suggested goal are ones the caller sees under RLS, never someone else's.
    pgPolicy("time_entries_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and (${t.oneOffId} is null or exists (
        select 1 from "goals"."one_offs" o where o.id = ${t.oneOffId}
      )) and (${t.suggestedGoalId} is null or exists (
        select 1 from "goals"."goals" g where g.id = ${t.suggestedGoalId}
      ))`,
    }),
    pgPolicy("time_entries_update_self", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy("time_entries_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

// Where an entry's minutes went (RP-151): one row confirms it whole, several split it. Only these rows add to a
// goal's measure. The sum per entry never passes the entry's minutes (`time_allocations_within_entry`, 0032).
export const timeAllocations = goalsSchema.table(
  "time_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    entryId: uuid()
      .notNull()
      .references(() => timeEntries.id, { onDelete: "cascade" }),
    goalId: uuid()
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    minutes: integer().notNull(),
  },
  (t) => [
    index("time_allocations_entry_id_idx").on(t.entryId),
    index("time_allocations_goal_id_idx").on(t.goalId),
    check("time_allocations_minutes_range", sql`${t.minutes} between 1 and 1000000`),
    pgPolicy("time_allocations_select_self", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
    // Entry and goal are the caller's own, and the entry is not dismissed.
    pgPolicy("time_allocations_insert_self", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId} and exists (
        select 1 from "goals"."time_entries" e where e.id = ${t.entryId} and e.dismissed_at is null
      ) and exists (
        select 1 from "goals"."goals" g where g.id = ${t.goalId}
      )`,
    }),
    pgPolicy("time_allocations_delete_self", {
      for: "delete",
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type TimeAllocation = typeof timeAllocations.$inferSelect;
