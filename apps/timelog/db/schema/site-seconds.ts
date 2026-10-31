import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// The site-day (RT-13): seconds one website's hostname was in front, the person at the computer, on one
// Bogotá day from one device. A hostname alone: never a path, a query or a page title. Written only by
// `timelog.replace_days`; the person reads their own.
export const siteSeconds = timeSchema.table(
  "site_seconds",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    host: text().notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day, t.host] }),
    check("site_seconds_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("site_seconds_device_length", sql`char_length(${t.device}) between 1 and 80`),
    check("site_seconds_host_shape", sql`${t.host} ~ '^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$'`),
    pgPolicy("site_seconds_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
