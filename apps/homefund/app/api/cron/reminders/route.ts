import { claimDueReminders } from "@/db/queries/reminder-mail";
import { env } from "@/lib/env";
import { todayInBogota } from "@/lib/dates";
import { gmailSender, mailDueReminders } from "@/lib/reminder-mail";

// RF-141: once a day, each planned payment whose reminder date has come mails its author.
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Nothing is claimed without a way to send, so the reminders wait for the credentials.
  if (!env.SMTP_USER || !env.SMTP_PASS) {
    return Response.json({ mailed: 0, failed: 0, skipped: "smtp" });
  }

  try {
    const result = await mailDueReminders(
      await claimDueReminders(todayInBogota()),
      gmailSender(env.SMTP_USER, env.SMTP_PASS),
      env.NEXT_PUBLIC_SITE_URL,
    );
    return Response.json(result);
  } catch (error) {
    console.error("reminder run failed", error);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
