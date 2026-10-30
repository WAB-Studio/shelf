import "server-only";

import { type DueReminder, releaseReminder } from "@/db/queries/reminder-mail";
import { composeReminderMail, type SendMail } from "@/lib/reminder-mail";

// One mail at a time: Gmail throttles bursts, and a family's day holds a handful at most.
export async function mailDueReminders(
  reminders: DueReminder[],
  send: SendMail,
  siteUrl: string,
): Promise<{ mailed: number; failed: number }> {
  let mailed = 0;
  let failed = 0;
  for (const reminder of reminders) {
    try {
      await send(await composeReminderMail(reminder, siteUrl));
      mailed += 1;
    } catch (error) {
      console.error("reminder mail failed", reminder.id, error);
      await releaseReminder(reminder.id);
      failed += 1;
    }
  }
  return { mailed, failed };
}
