import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// The window-day (RT-18): seconds one window title was in front inside one app, the person at the computer, on one
// Bogotá day from one device. Never a browser's: its titles are its pages. Written only by `timelog.replace_days`;
// the person reads their own.
export const windowSeconds = timeSchema.table(
  "window_seconds",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    app: text().notNull(),
    title: text().notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day, t.app, t.title] }),
    check("window_seconds_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("window_seconds_device_length", sql`char_length(${t.device}) between 1 and 80`),
    check("window_seconds_app_length", sql`char_length(${t.app}) between 1 and 120`),
    check("window_seconds_title_length", sql`char_length(${t.title}) between 1 and 300`),
    pgPolicy("window_seconds_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
