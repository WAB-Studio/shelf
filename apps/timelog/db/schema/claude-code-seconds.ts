import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// The Claude Code day (RT-14): seconds Claude Code was working on one Bogotá day from one device. A day
// with none has no row. Written only by `timelog.replace_days`; the person reads their own.
export const claudeCodeSeconds = timeSchema.table(
  "claude_code_seconds",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day] }),
    check("claude_code_seconds_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("claude_code_seconds_device_length", sql`char_length(${t.device}) between 1 and 80`),
    pgPolicy("claude_code_seconds_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
