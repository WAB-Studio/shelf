import { date, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { finances } from "./_schema";
import { plannedPayments } from "./planned-payments";

// RF-141: one row per reminder mailed, by payment and the reminder date it was mailed for, so a
// reminder moved to another date mails again. Kept off the payment row: a write there would stamp
// it, audit it and re-derive its scope. Closed like the allowed list: only the server's pool.
export const reminderMails = finances
  .table(
    "reminder_mails",
    {
      id: uuid().primaryKey().defaultRandom(),
      plannedPaymentId: uuid()
        .notNull()
        .references(() => plannedPayments.id, { onDelete: "cascade" }),
      remindOn: date({ mode: "string" }).notNull(),
      mailedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex("reminder_mails_payment_date_unique").on(table.plannedPaymentId, table.remindOn)],
  )
  .enableRLS();
