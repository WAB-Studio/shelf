import "server-only";

import { getTranslations } from "next-intl/server";
import nodemailer from "nodemailer";

import type { DueReminder } from "@/db/queries/reminder-mail";
import type { CurrencyCode } from "@/lib/currency";
import { FORMAT_LOCALE } from "@/lib/locales";
import { formatMoney } from "@/lib/money";

export type ReminderMail = { to: string; subject: string; text: string };

// Plain text only: the description is the person's own words and never reaches markup.
export async function composeReminderMail(reminder: DueReminder, siteUrl: string): Promise<ReminderMail> {
  const t = await getTranslations({ locale: reminder.locale, namespace: "reminderMail" });
  const name = reminder.description ?? t("unnamed");
  // A civil date, so it is drawn in UTC: a zone would move it a day.
  const due = new Intl.DateTimeFormat(FORMAT_LOCALE[reminder.locale], {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${reminder.dueDate}T00:00:00Z`));
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
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  return async (mail) => {
    await transport.sendMail({ from: { name: "HomeFund", address: user }, ...mail });
  };
}
