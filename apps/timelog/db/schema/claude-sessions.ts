import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// A Claude Code session on one Bogotá day from one device (RT-19): its id, the project folder it ran in, its first
// and last message of that day and the seconds it was working. Never a message. Written only by
// `timelog.replace_days`; the person reads their own.
export const claudeSessions = timeSchema.table(
  "claude_sessions",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    session: text().notNull(),
    project: text().notNull(),
    firstAt: timestamp({ withTimezone: true }).notNull(),
    lastAt: timestamp({ withTimezone: true }).notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day, t.session] }),
    check("claude_sessions_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("claude_sessions_device_length", sql`char_length(${t.device}) between 1 and 80`),
    check("claude_sessions_session_length", sql`char_length(${t.session}) between 1 and 80`),
    check("claude_sessions_project_length", sql`char_length(${t.project}) between 1 and 200`),
    pgPolicy("claude_sessions_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
