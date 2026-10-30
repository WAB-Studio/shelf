import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { DueReminder } from "@/db/queries/due-reminders";
import { settledIn } from "@/db/queries/planned-payments";
import type { Locale } from "@/lib/locales";

// RF-159's due reminder, with who it mails and the reminder date it is mailed for.
export type ReminderMailTarget = DueReminder & { email: string; locale: Locale; remindOn: string };

// The cron runs as no one, so this reads past the policies on the owner's pool. A reminder is
// claimed by recording it before its mail goes out: two runs never mail one reminder date twice.
// Only the last few reminder dates count, so a cron that missed a day catches up and the first
// run never mails a backlog of old ones; a payment already past due is not reminded.
export async function claimDueReminders(today: string): Promise<ReminderMailTarget[]> {
  const rows = await db.execute<{
    id: string;
    email: string;
    locale: Locale;
    description: string | null;
    amount_cents: string;
    currency: string;
    due_date: string;
    remind_on: string;
  }>(sql`
    with due as (
      select p.id, p.remind_on
      from finances.planned_payments p
      where p.status = 'pending'
        and p.remind_on between ${today}::date - 2 and ${today}::date
        and p.due_date >= ${today}::date
        -- Only an author with an address to mail is claimed: no row says a mail went out that did not.
        and exists (select 1 from auth.users u where u.id = p.created_by and u.email is not null)
        and exists (select 1 from finances.app_users a where a.id = p.created_by)
        -- A fund payment reminds its author only while they are still in that fund.
        and (
          p.group_id is null
          or exists (
            select 1 from finances.group_members m
            where m.group_id = p.group_id and m.user_id = p.created_by and m.archived_at is null
          )
        )
    ),
    claimed as (
      insert into finances.reminder_mails (planned_payment_id, remind_on)
      select id, remind_on from due
      on conflict do nothing
      returning planned_payment_id as id, remind_on
    )
    select c.id, u.email, a.locale, c.description, c.amount_cents::text as amount_cents, c.due_date::text as due_date,
      claimed.remind_on::text as remind_on, ${settledIn} as currency
    from claimed
    join finances.planned_payments c on c.id = claimed.id
    join auth.users u on u.id = c.created_by
    join finances.app_users a on a.id = c.created_by
    left join finances.accounts from_account on from_account.id = c.from_account_id
    left join finances.accounts to_account on to_account.id = c.to_account_id
  `);

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    locale: row.locale,
    description: row.description,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    dueDate: row.due_date,
    remindOn: row.remind_on,
  }));
}

// A mail that did not leave hands its reminder date back, so the next run tries again. Should the
// run die between the claim and the send, that date is not mailed: a missed reminder, never two.
export async function releaseReminder({ id, remindOn }: ReminderMailTarget): Promise<void> {
  await db.execute(
    sql`delete from finances.reminder_mails where planned_payment_id = ${id} and remind_on = ${remindOn}::date`,
  );
}
