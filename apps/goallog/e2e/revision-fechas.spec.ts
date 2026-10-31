import type { Page } from "@playwright/test";

import { civilDateInZone, civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, laneNumber } from "./fixtures";

function dayAfter(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const format = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function range(from: string, to: string): string {
  // ICU writes «sept» and spaces a cross-month dash; the screen writes «sep» and «28 sep–4 oct 2026» (RP-17).
  return format.formatRange(civilDateToDate(from), civilDateToDate(to)).replaceAll("sept", "sep").replace(/\s+–\s+/, "–");
}

// The Wednesday of the week two Mondays back, so the review holds three
// weeks whatever weekday the spec runs on.
test("each review row prints its dates, week 1 from the opening day to its Sunday (RP-17, RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta fechas ${lane} ${Date.now()}`;
  const measureName = `Medida fechas ${lane} ${Date.now()}`;

  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(goalName);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalId = page.url().split("/metas/")[1];

  try {
    await addMeasure(page, goalId, measureName);

    const firstMonday = dayAfter(weekOf(todayInZone())[0], -14);
    const openedOn = dayAfter(firstMonday, 2);
    const openedDaysBack =
      (civilDateToDate(todayInZone()).getTime() - civilDateToDate(openedOn).getTime()) / 86_400_000;
    const backdatedAt = new Date(Date.now() - openedDaysBack * 86_400_000);
    expect(civilDateInZone(backdatedAt)).toBe(openedOn);
    await db`update goals.goals set created_at = ${backdatedAt} where id = ${goalId} and user_id = ${personId}`;

    const week1 = range(openedOn, dayAfter(firstMonday, 6));
    const week2 = range(dayAfter(firstMonday, 7), dayAfter(firstMonday, 13));
    const week3 = range(dayAfter(firstMonday, 14), dayAfter(firstMonday, 20));
    expect(week1).not.toBe(week2);

    await page.goto(`/metas/${goalId}/revision`);

    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText(week1);
    await expect(items.nth(1)).toContainText(week2);
    await expect(items.nth(2)).toContainText(week3);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(items.nth(0)).toContainText(week1);
    await expect(items.nth(1)).toContainText(week2);
    await expect(items.nth(2)).toContainText(week3);
    // The label column is one width on every row, the longest range included.
    const labelWidths = await items.evaluateAll((els) =>
      els.map((el) => (el.children[1] as HTMLElement).getBoundingClientRect().width),
    );
    expect(new Set(labelWidths.map(Math.round)).size).toBe(1);
    expect(labelWidths[0]).toBeGreaterThanOrEqual(110);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

// A review whose rows include a week that spans two months: every date line
// stays on one line and the page holds 360px.
test("a review with a week across two months keeps each date on one line at 360 px (RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta fechas mes ${lane} ${Date.now()}`;
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(goalName);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalId = page.url().split("/metas/")[1];

  try {
    await addMeasure(page, goalId, `Medida fechas mes ${lane} ${Date.now()}`);

    // The latest week, today's included, whose Monday and Sunday sit in different months.
    let monday = weekOf(todayInZone())[0];
    while (monday.slice(0, 7) === dayAfter(monday, 6).slice(0, 7)) monday = dayAfter(monday, -7);
    const openedOn = dayAfter(monday, -14 + 2);
    const openedDaysBack =
      (civilDateToDate(todayInZone()).getTime() - civilDateToDate(openedOn).getTime()) / 86_400_000;
    const backdatedAt = new Date(Date.now() - openedDaysBack * 86_400_000);
    expect(civilDateInZone(backdatedAt)).toBe(openedOn);
    await db`update goals.goals set created_at = ${backdatedAt} where id = ${goalId} and user_id = ${personId}`;

    await page.goto(`/metas/${goalId}/revision`);
    const crossing = range(monday, dayAfter(monday, 6));
    const items = page.getByRole("listitem");
    await expect(items).not.toHaveCount(0);
    expect(await items.count()).toBeGreaterThanOrEqual(3);
    await expect(items.filter({ hasText: crossing })).toHaveCount(1);

    const dates = page.locator("li > span:first-child > span");
    const count = await dates.count();
    for (let i = 0; i < count; i++) {
      const box = await dates.nth(i).evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        font: parseFloat(getComputedStyle(el).fontSize),
        overflow: el.scrollWidth - el.clientWidth,
      }));
      expect(box.height).toBeLessThan(box.font * 1.8);
      expect(box.overflow).toBeLessThanOrEqual(0);
    }
    // The label column is one width on every row, the longest range included.
    const labels = await page
      .locator("li > span:first-child")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(new Set(labels).size).toBe(1);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

async function addMeasure(page: Page, goalId: string, name: string): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "un número", exact: true }).click();
  await page.getByLabel("cantidad", { exact: true }).fill("5");
  await page.getByLabel("unidad").fill("minutos");
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}
