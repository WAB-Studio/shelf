import "server-only";

import { getTranslations } from "next-intl/server";
import nodemailer from "nodemailer";

import { releaseReminder, type ReminderMailTarget } from "@/db/queries/reminder-mail";
import type { CurrencyCode } from "@/lib/currency";
import { civilDateToDate } from "@/lib/dates";
import { FORMAT_LOCALE } from "@/lib/locales";
import { formatMoney } from "@/lib/money";

export type ReminderMail = { to: string; subject: string; text: string };

// Plain text only: the description is the person's own words and never reaches markup.
export async function composeReminderMail(reminder: ReminderMailTarget, siteUrl: string): Promise<ReminderMail> {
  const t = await getTranslations({ locale: reminder.locale, namespace: "reminderMail" });
  const name = reminder.description?.trim() || t("unnamed");
  // A civil date, so it is drawn in UTC: a zone would move it a day.
  const due = new Intl.DateTimeFormat(FORMAT_LOCALE[reminder.locale], {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(civilDateToDate(reminder.dueDate));
  const amount = formatMoney(reminder.amountCents, reminder.currency as CurrencyCode, reminder.locale);
  const url = `${siteUrl}/${reminder.locale}/planning/payments`;

  return {
    to: reminder.email,
    subject: t("subject", { name, due }),
    text: [t("greeting"), t("body", { name, amount, due }), t("action", { url }), t("footer")].join("\n\n"),
  };
}

export type SendMail = (mail: ReminderMail) => Promise<void>;

// Gmail over SMTP, the account and sender name Auth's own mail already uses.
export function gmailSender(user: string, pass: string): SendMail {
  // One pooled connection: a run's mails share a login, one at a time.
  const transport = nodemailer.createTransport({
    pool: true,
    maxConnections: 1,
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return async (mail) => {
    await transport.sendMail({ from: { name: "HomeFund", address: user }, ...mail });
  };
}

// One mail at a time: Gmail throttles bursts, and a family's day holds a handful at most.
export async function mailDueReminders(
  reminders: ReminderMailTarget[],
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
      failed += 1;
      // A release that fails too leaves this one unmailed, never the rest of the run.
      await releaseReminder(reminder).catch((releaseError: unknown) =>
        console.error("reminder release failed", reminder.id, releaseError),
      );
    }
  }
  return { mailed, failed };
}
