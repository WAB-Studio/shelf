
import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// `/metas` lists an ended goal apart, under «terminadas», between the open
// ones and «Archivadas» (RP-27, RP-24, RNP-07).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// A person of this spec's own: only a fresh identity has no other goal, which
// the only-ended case needs. Registered under the suite's run, whose teardown
// drops it.
async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  horizon: string,
  archived = false,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at, created_at)
    values (${personId}, ${name}, ${horizon}, ${archived ? new Date() : null},
            ${new Date(Date.now() - 20 * 86_400_000)})
    returning id
  `;
  return row.id;
}

test("one open, one ended and one archived goal list each under its heading, in order, and each row opens its goal", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    const stamp = Date.now();
    const open = `Abierta ${stamp}`;
    const ended = `Fin ${stamp % 100000}`;
    const archived = `Archivada ${stamp}`;
    const openId = await seedGoal(db, person.id, open, plusDays(60));
    // The last day it counted is the 13th: the horizon is the day after.
    const endedId = await seedGoal(db, person.id, ended, "2026-09-14");
    const archivedId = await seedGoal(db, person.id, archived, plusDays(60), true);

    await page.goto("/metas");
    const terminadas = page.getByText("terminadas", { exact: true });
    const archivadas = page.getByText("Archivadas", { exact: true });
    await expect(terminadas).toBeVisible();

    // Document order: open, «Abrir otra meta», «terminadas», ended, «Archivadas», archived.
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll("main a, main h2, main section *"))
        .map((el) => el.textContent?.trim() ?? ""),
    );
    const at = (needle: string) => order.findIndex((text) => text.startsWith(needle));
    expect(at(open)).toBeGreaterThanOrEqual(0);
    expect(at(open)).toBeLessThan(at("Abrir otra meta"));
    expect(at("Abrir otra meta")).toBeLessThan(at("terminadas"));
    expect(at("terminadas")).toBeLessThan(at(ended));
    expect(at(ended)).toBeLessThan(at("Archivadas"));
    expect(at("Archivadas")).toBeLessThan(at(archived));
    await expect(archivadas).toBeVisible();
    const endedRow = page.getByRole("link", { name: `${ended} terminó el 13 sep 2026`, exact: true });
    await expect(endedRow).toBeVisible();

    // The annotation is the row's second line, under the name and inside the row.
    const rowBox = await endedRow.boundingBox();
    const nameBox = await endedRow.getByText(ended, { exact: true }).boundingBox();
    const noteBox = await endedRow.getByText("terminó el 13 sep 2026").boundingBox();
    expect(rowBox && nameBox && noteBox).toBeTruthy();
    expect(noteBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
    expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height);
    expect(noteBox!.x + noteBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    for (const [name, id] of [
      [open, openId],
      [ended, endedId],
      [archived, archivedId],
    ]) {
      await page.goto("/metas");
      await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
      await page.waitForURL(new RegExp(`/metas/${id}$`));
    }
  } finally {
    await context.close();
  }
});

test("a person whose only goal ended lands on the list, not on /metas/nueva", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    const ended = `Sola terminada ${Date.now()}`;
    await seedGoal(db, person.id, ended, todayInZone());

    await page.goto("/metas");
    await expect(page).toHaveURL(/\/metas$/);
    await expect(page.getByText("terminadas", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`^${ended}`) })).toBeVisible();
  } finally {
    await context.close();
  }
});
