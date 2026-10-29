import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// The app-day (RT-01): seconds one app was in front, the person at the computer, on one Bogotá day
// from one device. Written only by `timelog.replace_day`; the person reads their own.
export const appSeconds = timeSchema.table(
  "app_seconds",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    app: text().notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day, t.app] }),
    check("app_seconds_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("app_seconds_device_length", sql`char_length(${t.device}) between 1 and 80`),
    check("app_seconds_app_length", sql`char_length(${t.app}) between 1 and 120`),
    pgPolicy("app_seconds_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
