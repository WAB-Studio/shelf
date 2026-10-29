import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

// RP-19's carry (`HoySueltaAtrasada.dc.html`): a one-off undone since an
// earlier day reads on Hoy, first, with «del sábado 19» under it. Each test
// seeds its own rows straight into `goals.one_offs` — the field only ever
// writes today's — and drops them by the ids it got back, never by name.

function pastDay(daysAgo: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return dateToCivilDate(date);
}

// The spec's own oracle for «del sábado 19»: ICU's Spanish weekday, never the
// catalogue's list the screen reads, so a list shifted by a day still fails.
function carriedLabel(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  const month = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(date);
  // The month appears only outside the week of today.
  return weekOf(todayInZone()).includes(day)
    ? `del ${weekday} ${date.getUTCDate()}`
    : `del ${weekday} ${date.getUTCDate()} de ${month}`;
}

async function seedOneOff(db: postgres.Sql, personId: string, name: string, day: string): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day)
    values (${personId}, ${name}, ${day}) returning id
  `;
  return row.id;
}

// Every fact a one-off carries goes with it (`facts.one_off_id`'s cascade).
async function dropOneOffs(db: postgres.Sql, ids: string[]): Promise<void> {
  await db`delete from goals.one_offs where id = any(${ids})`;
}

// The name half of `Row`'s split shape: its accessible name is the text and,
// when there is one, the second line under it.
function nameButton(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^${name}`) });
}

test("a one-off from two days back reads on Hoy with its day, before today's, which carry none (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const carriedName = `Suelta atrasada ${stamp}`;
  const todayName = `Suelta de hoy ${stamp}`;
  const carriedDay = pastDay(2);
  const ids = [
    await seedOneOff(db, personId, todayName, todayInZone()),
    await seedOneOff(db, personId, carriedName, carriedDay),
  ];

  try {
    await page.goto("/");
    const carried = nameButton(page, carriedName);
    await expect(carried).toHaveAccessibleName(`${carriedName} ${carriedLabel(carriedDay)}`);

    const fresh = nameButton(page, todayName);
    await expect(fresh).toHaveAccessibleName(todayName);

    // Seeded today's first, so creation order alone would put it on top.
    const [carriedBox, freshBox] = [await carried.boundingBox(), await fresh.boundingBox()];
    expect(carriedBox!.y).toBeLessThan(freshBox!.y);
  } finally {
    await dropOneOffs(db, ids);
  }
});

test("completed from Hoy, a carried one-off moves to «hechas hoy» and a reload keeps it there, its fact on today (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta atrasada hecha ${Date.now()}`;
  const id = await seedOneOff(db, personId, name, pastDay(2));

  try {
    await page.goto("/");
    const row = nameButton(page, name);
    await expect(row).toBeVisible();

    await row.locator("xpath=ancestor::div[1]").getByRole("button", { name: "Marcar como hecho" }).click();
    const undo = page.getByRole("button", { name: `Deshacer: ${name}` });
    await expect(undo).toBeVisible();
    await page.reload();
    await expect(page.getByPlaceholder("Escribe una tarea…")).toBeVisible();
    await expect(undo).toBeVisible();

    const facts = await db<{ day: string }[]>`
      select day::text as day from goals.facts where one_off_id = ${id}
    `;
    expect(facts).toEqual([{ day: todayInZone() }]);
  } finally {
    await dropOneOffs(db, [id]);
  }
});

test("deleted from Hoy, a carried one-off leaves, a reload keeps it gone, and nothing of it stays (RP-19, RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta atrasada borrada ${Date.now()}`;
  const id = await seedOneOff(db, personId, name, pastDay(2));

  try {
    await page.goto("/");
    await nameButton(page, name).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Borrar la tarea" }).click();
    await sheet.getByRole("button", { name: "Borrarla" }).click();
    await expect(sheet).toBeHidden();
    await expect(nameButton(page, name)).toHaveCount(0);

    await page.reload();
    await expect(page.getByPlaceholder("Escribe una tarea…")).toBeVisible();
    await expect(nameButton(page, name)).toHaveCount(0);

    expect(await db`select id from goals.one_offs where id = ${id}`).toHaveLength(0);
  } finally {
    await dropOneOffs(db, [id]);
  }
});

test("Hoy holds at 360px with a carried one-off on it (RNP-07)", async ({ page, db, personId }) => {
  const name = `Suelta atrasada con un nombre largo que no cabe en una línea ${Date.now()}`;
  const day = pastDay(2);
  const id = await seedOneOff(db, personId, name, day);

  try {
    await page.goto("/");
    await expect(page.getByText(carriedLabel(day)).first()).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
    await page.screenshot({ path: "private/hoy-suelta-atrasada-360.png", fullPage: true });
  } finally {
    await dropOneOffs(db, [id]);
  }
});
