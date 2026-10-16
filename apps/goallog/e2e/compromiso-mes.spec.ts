import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import plan from "../messages/es/plan.json";

// «N al mes», the fifth chip of «cada cuándo» (`CompromisoNuevoMes.dc.html`, RP-12).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("«N al mes» swaps the row for «veces al mes», stores times_per_month and the goal screen names it (RP-12)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const commitmentName = `Llamar ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${`Meta mensual ${stamp}`}, ${plusDays(90)}) returning id
  `;

  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/compromisos/nuevo`);
    // `load` fires with the loading fallback still standing; act on the settled page.
    await expect(page.getByLabel("qué es")).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);

    await page.getByLabel("qué es").fill(commitmentName);
    await page.getByRole("button", { name: plan.commitmentForm.cadence.times_per_month, exact: true }).click();
    await expect(page.getByLabel("veces por semana")).toHaveCount(0);
    await expect(page.getByText("Cualquier día del mes cuenta.")).toBeVisible();
    await page.getByLabel("veces al mes").fill("2");
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goal.id}`);

    const [row] = await db<{ cadence_kind: string; cadence_n: number | null }[]>`
      select cadence_kind, cadence_n from goals.commitments
      where user_id = ${person.id} and name = ${commitmentName}
    `;
    expect(row).toEqual({ cadence_kind: "times_per_month", cadence_n: 2 });

    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText(commitmentName)).toBeVisible();
    await expect(page.getByText("2 veces al mes")).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("«N al mes» with 32 is refused on screen and writes no row (RP-12)", async ({ person, browser, db }) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${`Meta mensual ${stamp}`}, ${plusDays(90)}) returning id
  `;

  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/compromisos/nuevo`);
    await expect(page.getByLabel("qué es")).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await page.getByLabel("qué es").fill(`Demasiado ${stamp}`);
    await page.getByRole("button", { name: plan.commitmentForm.cadence.times_per_month, exact: true }).click();
    await page.getByLabel("veces al mes").fill("32");
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await expect(page.getByText("entre 1 y 31")).toBeVisible();
    const rows = await db`select 1 from goals.commitments where user_id = ${person.id}`;
    expect(rows.length).toBe(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
