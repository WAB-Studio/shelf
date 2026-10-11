import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";

// Module 817 (RP-17), `RevisionConAño`: every row of a goal's review says its range with the year, on one line under
// the week label, and an ended goal's last row stops on its last day with no «en curso».

type Db = postgres.Sql;

function dayAfter(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const format = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function range(from: string, to: string): string {
  return format.formatRange(civilDateToDate(from), civilDateToDate(to)).replaceAll("sept", "sep").replace(/\s+–\s+/, "–");
}

async function seed(
  db: Db,
  personId: string,
  options: { openedOn: string; horizon: string; measure: string; unit: string },
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Revisión año ${Date.now()}`}, ${options.horizon}::date, ${options.measure}, ${options.unit},
            (${options.openedOn}::date + time '17:00') at time zone 'UTC')
    returning id`;
  return goal.id;
}

async function drop(db: Db, personId: string, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

// The phone's stack: one `li` per week, its range the span under the label.
const items = (page: import("@playwright/test").Page) => page.getByRole("listitem");

test("a week across two months says both months and the year; an ended goal's last row stops on its last day, never «en curso» (RP-17)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seed(db, personId, { openedOn: "2026-09-28", horizon: "2026-10-08", measure: "minutos", unit: "minutos" });
  try {
    await page.goto(`/metas/${goalId}/revision`);
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText("28 sep–4 oct 2026");
    await expect(items(page).nth(1)).toContainText("5–7 oct 2026");
    expect(await page.getByRole("main").first().innerText()).not.toContain("en curso");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1280, height: 900 });
    const rows = page.getByRole("table").getByRole("row");
    await expect(rows.nth(1).getByRole("cell").nth(0)).toContainText("28 sep–4 oct 2026");
    await expect(rows.nth(2).getByRole("cell").nth(0)).toContainText("5–7 oct 2026");
    expect(await page.getByRole("table").innerText()).not.toContain("en curso");
  } finally {
    await drop(db, personId, goalId);
  }
});

test("a week across two years says both years, on one line, and the page holds 360 px (RP-17)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seed(db, personId, { openedOn: "2025-12-29", horizon: "2026-01-10", measure: "minutos", unit: "minutos" });
  try {
    await page.goto(`/metas/${goalId}/revision`);
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText("29 dic 2025–4 ene 2026");
    await expect(items(page).nth(1)).toContainText("5–9 ene 2026");

    const detail = items(page).nth(0).getByText("29 dic 2025–4 ene 2026");
    const box = await detail.evaluate((el) => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) }));
    expect(box.height).toBeLessThan(box.font * 1.8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("table").getByRole("row").nth(1).getByRole("cell").nth(0)).toContainText("29 dic 2025–4 ene 2026");
  } finally {
    await drop(db, personId, goalId);
  }
});

test("an open goal's row for today carries its year and says «en curso» once (RP-17)", async ({ page, db, personId }) => {
  const [monday] = weekOf(todayInZone());
  const goalId = await seed(db, personId, {
    openedOn: dayAfter(monday, -12),
    horizon: dayAfter(monday, 60),
    measure: "minutos",
    unit: "minutos",
  });
  try {
    await page.goto(`/metas/${goalId}/revision`);
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).nth(1)).toContainText(range(dayAfter(monday, -7), dayAfter(monday, -1)));
    await expect(items(page).nth(2)).toContainText(range(monday, dayAfter(monday, 6)));
    await expect(items(page).filter({ hasText: "en curso" })).toHaveCount(1);
    await expect(items(page).nth(2)).toContainText("en curso");
    // The note owns its own track: it starts at or right of the figure's right edge, never under or over it.
    const current = items(page).nth(2);
    const figure = await current.locator(":scope > span").nth(1).boundingBox();
    const note = await current.locator(":scope > span").nth(2).boundingBox();
    expect(note!.x, `«en curso» starts at ${note!.x}px, the figure ends at ${figure!.x + figure!.width}px`).toBeGreaterThanOrEqual(
      figure!.x + figure!.width - 0.5,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("a searches goal reads «0 búsquedas» on a row that carries its year (RP-17, RP-71)", async ({ page, db, personId }) => {
  const goalId = await seed(db, personId, { openedOn: "2026-09-28", horizon: "2026-10-08", measure: "búsquedas", unit: "searches" });
  try {
    await page.goto(`/metas/${goalId}/revision`);
    await expect(items(page)).toHaveCount(2);
    const last = (await items(page).nth(1).innerText()).replace(/\s+/g, " ");
    expect(last).toContain("5–7 oct 2026");
    expect(last).toMatch(/0 búsquedas$/);
    expect(await page.getByRole("main").first().innerText()).not.toMatch(/searches/i);
  } finally {
    await drop(db, personId, goalId);
  }
});
