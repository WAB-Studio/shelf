import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// The field's day (`HoySueltaDia.dc.html`): Enter alone writes today; the
// chips write tomorrow, another day, or none (RP-19, RP-59).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function rowsNamed(db: postgres.Sql, personId: string, name: string) {
  return db<{ id: string; day: string | null }[]>`
    select id, day::text as day from goals.one_offs where user_id = ${personId} and name = ${name}
  `;
}

async function dropByName(db: postgres.Sql, personId: string, name: string): Promise<void> {
  const rows = await rowsNamed(db, personId, name);
  if (rows.length > 0) await db`delete from goals.one_offs where id = any(${rows.map((r) => r.id)})`;
}

test("Enter alone writes a one-off for today that draws on Hoy, and the chips default to hoy (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta solo Enter ${Date.now()}`;
  try {
    await page.goto("/");
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await expect(page.getByRole("radio", { name: "hoy" })).toHaveAttribute("aria-checked", "true");
    await field.press("Enter");

    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    expect(await rowsNamed(db, personId, name)).toMatchObject([{ day: todayInZone() }]);
  } finally {
    await dropByName(db, personId, name);
  }
});

test("«mañana» writes tomorrow's day, does not draw, and says where it went (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta mañana ${Date.now()}`;
  try {
    await page.goto("/");
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await expect(page.getByRole("button", { name: "Anotar" })).toHaveCount(0);
    await page.getByRole("radio", { name: "mañana" }).click();
    await page.getByRole("button", { name: "Anotar" }).click();

    await expect(page.getByRole("status")).toContainText("Anotada para mañana");
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    expect(await rowsNamed(db, personId, name)).toMatchObject([{ day: plusDays(1) }]);
  } finally {
    await dropByName(db, personId, name);
  }
});

test("«sin día» writes a null day, does not draw, and the way into the list shows (RP-59)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta sin día ${Date.now()}`;
  try {
    await page.goto("/");
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await page.getByRole("radio", { name: "sin día" }).click();
    await expect(page.getByRole("button", { name: "Anotar" })).toBeVisible();
    await field.press("Enter");

    await expect(page.getByRole("status")).toContainText("Anotada sin día");
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    expect(await rowsNamed(db, personId, name)).toMatchObject([{ day: null }]);
    // The count is the identity's, and `sueltas.spec.ts` moves it in parallel:
    // the row above proves the write, the link proves the way in.
    await expect(page.getByRole("link", { name: /^\d+ (espera|esperan)$/ })).toHaveAttribute(
      "href",
      "/sueltas",
    );
  } finally {
    await dropByName(db, personId, name);
  }
});

test("«otro día» takes a date; a past one is refused with its message and no row (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta otro día ${Date.now()}`;
  try {
    await page.goto("/");
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await page.getByRole("radio", { name: "otro día" }).click();
    const date = page.getByLabel("qué día");
    await expect(page.getByRole("button", { name: "Anotar" })).toBeVisible();

    await date.fill(plusDays(-1));
    await field.press("Enter");
    await expect(page.getByText("Ese día ya pasó. Elige hoy o uno por venir.")).toBeVisible();
    await expect(date).toHaveAttribute("aria-invalid", "true");
    expect(await rowsNamed(db, personId, name)).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await date.fill(plusDays(3));
    await date.press("Enter");
    await expect(page.getByRole("status")).toContainText("Anotada para el");
    expect(await rowsNamed(db, personId, name)).toMatchObject([{ day: plusDays(3) }]);
  } finally {
    await dropByName(db, personId, name);
  }
});
