import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import goal from "../messages/es/goal.json";

import { test, expect } from "./fixtures";
import { boxOf } from "./box";

// `/sueltas` is a 640px column and `/metas` names no empty group (RP-59,
// RP-11, RNP-17; DESIGN «An empty section draws no label»).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("at 1440 a /sueltas row is at most 640px wide and its note button sits within 640px of the name", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const name = `Suelta columna ${Date.now()}`;
    await db`insert into goals.one_offs (user_id, name, day, note)
             values (${person.id}, ${name}, null, 'una nota')`;

    await page.goto("/sueltas");
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await expect(row).toBeVisible();
    const rowBox = (await boxOf(row));
    expect(rowBox.width).toBeLessThanOrEqual(640);

    const note = page.getByRole("button", { name: /nota/i }).first();
    await expect(note).toBeVisible();
    const noteBox = (await boxOf(note));
    expect(noteBox.x + noteBox.width - rowBox.x).toBeLessThanOrEqual(640);
  } finally {
    await context.close();
  }
});

test("/metas with only ended and archived goals draws no «abiertas» label and offers «Abrir una meta»", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const goalIds: string[] = [];
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 800 });
    const old = new Date(Date.now() - 20 * 86_400_000);
    const [ended] = await db<{ id: string }[]>`insert into goals.goals (user_id, name, horizon, created_at)
             values (${person.id}, ${`Fin ${Date.now() % 100000}`}, '2026-09-14', ${old}) returning id`;
    goalIds.push(ended.id);
    const [archived] = await db<{ id: string }[]>`insert into goals.goals (user_id, name, horizon, archived_at, created_at)
             values (${person.id}, ${`Arch ${Date.now()}`}, ${plusDays(60)}, ${new Date()}, ${old}) returning id`;
    goalIds.push(archived.id);

    await page.goto("/metas");
    await expect(page.getByText(goal.list.endedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(goal.list.openTitle, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: goal.none.action })).toBeVisible();
    await expect(page.getByRole("link", { name: goal.list.addAnother })).toHaveCount(0);
  } finally {
    await context.close();
    if (goalIds.length) await db`delete from goals.goals where id = any(${goalIds}) and user_id = ${person.id}`;
  }
});
