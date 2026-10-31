import { sql } from "drizzle-orm";
import { check, date, integer, pgPolicy, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authenticatedRole, authUid, authUsers } from "drizzle-orm/supabase";

import { timeSchema } from "./_schema";

// The page-day (RT-18): seconds one page (its address without query or fragment, and its title) was in front on one
// Bogotá day from one device. Written only by `timelog.replace_days`; the person reads their own.
export const pageSeconds = timeSchema.table(
  "page_seconds",
  {
    userId: uuid()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    device: text().notNull(),
    day: date().notNull(),
    host: text().notNull(),
    url: text().notNull(),
    title: text().notNull(),
    seconds: integer().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device, t.day, t.url, t.title] }),
    check("page_seconds_seconds_range", sql`${t.seconds} between 1 and 86400`),
    check("page_seconds_device_length", sql`char_length(${t.device}) between 1 and 80`),
    check("page_seconds_host_shape", sql`${t.host} ~ '^[a-z0-9]([a-z0-9.-]{0,118}[a-z0-9])?$'`),
    check("page_seconds_url_shape", sql`${t.url} ~ '^https?://' and ${t.url} !~ '[?#]' and char_length(${t.url}) <= 500`),
    check("page_seconds_title_length", sql`char_length(${t.title}) <= 300`),
    pgPolicy("page_seconds_select_self", { for: "select", to: authenticatedRole, using: sql`${authUid} = ${t.userId}` }),
  ],
);
