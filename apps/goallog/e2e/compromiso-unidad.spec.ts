import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";

// A goal opened through `/metas/nueva`, the least it takes (RP-11).
async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

async function addQuantity(page: Page, goalId: string, name: string, unit: string | null): Promise<void> {
  await page.goto(`/metas/${goalId}/compromisos/nuevo`);
  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "un número", exact: true }).click();
  await page.getByLabel("cantidad", { exact: true }).fill("5");
  if (unit !== null) await page.getByLabel("unidad", { exact: true }).fill(unit);
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}

test("on a measured goal the unit is text beside the quantity, no field, and the saved commitment carries the goal's unit; with no measure the field is there (361)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await createGoal(page, `Meta medida ${Date.now()}`);
  const second = `Segundo compromiso ${Date.now()}`;

  try {
    await page.goto(`/metas/${goalId}/compromisos/nuevo`);
    await page.getByRole("button", { name: "un número", exact: true }).click();
    await expect(page.getByLabel("unidad", { exact: true })).toBeVisible();

    await addQuantity(page, goalId, `Primero ${Date.now()}`, "minutos");

    await page.goto(`/metas/${goalId}/compromisos/nuevo`);
    await page.getByLabel("qué es").fill(second);
    await page.getByRole("button", { name: "un número", exact: true }).click();
    await expect(page.getByLabel("unidad", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("commitment-unit")).toHaveText("minutos");
    await page.getByLabel("cantidad", { exact: true }).fill("7");
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    const [row] = await db<{ unit: string | null }[]>`
      select unit from goals.commitments where user_id = ${personId} and name = ${second}
    `;
    expect(row.unit).toBe("minutos");
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
