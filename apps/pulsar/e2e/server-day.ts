import { expect, type Browser } from "@playwright/test";

import { civilDateToDate, todayInZone } from "@/lib/zone";

import type { Person } from "./fixtures";
import { shift } from "./sin-final-seed";

// The day of a spec is the day the server reads, not the day the spec's own process reads: `PULSAR_CLOCK` may pin the server
// alone, and the signed-in layout then draws that day in a `pulsar-clock` meta. With no pin the two clocks are the real one.
export type Days = { today: string; weekStart: string; eightWeeksAgo: string };

export async function serverDays(browser: Browser, baseURL: string | undefined, person: Person): Promise<Days> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const response = await context.request.get("/mes");
    expect(response.ok()).toBe(true);
    const html = await response.text();
    const pinned = /<meta name="pulsar-clock" content="(\d{4}-\d{2}-\d{2})"/.exec(html)?.[1];
    const today = pinned ?? todayInZone();
    const index = (civilDateToDate(today).getUTCDay() + 6) % 7;
    const weekStart = shift(today, -index);
    // A Monday 8 weeks back: a weekly habit made then has closed weeks in this month on most days and none on a few.
    return { today, weekStart, eightWeeksAgo: shift(weekStart, -56) };
  } finally {
    await context.close();
  }
}
