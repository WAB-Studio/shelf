import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";

// RP-35 on Hoy: a time unit reads «1 h 30 min», any other unit as it was
// written. Each spec seeds its own goal through the screen and drops it by id.

async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

async function addQuantityCommitment(
  page: Page,
  goalId: string,
  name: string,
  target: number,
  unit: string,
): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "un número", exact: true }).click();
  await page.getByLabel("cantidad", { exact: true }).fill(String(target));
  await page.getByLabel("unidad").fill(unit);
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test("a time row reads in hours and minutes, a page row as written; the partial and the chips follow (RP-35, RNP-02)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const timeName = `Horas tiempo ${stamp}`;
  const pagesName = `Horas páginas ${stamp}`;
  // A goal's first quantity sets its unit and the next ones take it (361), so
  // each unit lives in its own goal.
  const goalId = await createGoal(page, `Meta horas ${stamp}`);
  const pagesGoalId = await createGoal(page, `Meta páginas ${stamp}`);
  await addQuantityCommitment(page, goalId, timeName, 90, "minutos");
  await addQuantityCommitment(page, pagesGoalId, pagesName, 12, "páginas");

  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    const timeRow = page.locator("button", { hasText: timeName });
    const pagesRow = page.locator("button", { hasText: pagesName });
    await expect(timeRow).toContainText("1 h 30 min");
    await expect(timeRow).not.toContainText("minutos");
    await expect(pagesRow).toContainText("12 páginas");

    await timeRow.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    const spread = ["30 min", "45 min", "1 h", "1 h 15 min", "1 h 30 min", "2 h", "2 h 30 min", "3 h"];
    for (const label of spread) {
      await expect(sheet.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(sheet.getByRole("button", { name: "1 h 29 min", exact: true })).toHaveCount(0);
    await expect(sheet).not.toContainText("min minutos");
    await expect(sheet).not.toContainText("minutos");
    // The chips wrap inside the sheet: nothing is wider than the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const edges = await sheet.getByRole("button").evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().right),
    );
    expect(Math.max(...edges)).toBeLessThanOrEqual(360);

    // One tap on a chip lands 45 (RNP-02's measure).
    const tapped = Date.now();
    await sheet.getByRole("button", { name: "45 min", exact: true }).click();
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();
    expect(Date.now() - tapped).toBeLessThan(5000);
    await expect(timeRow).toContainText("45 min de 1 h 30 min");

    // Past the target the row is done and reads what was logged.
    await timeRow.click();
    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill("100");
    await sheet.getByRole("button", { name: "Cambiar" }).click();
    await expect(sheet).toBeHidden();
    await expect(timeRow).toContainText("1 h 40 min");
    await expect(timeRow).not.toContainText("100 minutos");

    // One tap on the chip already selected lands the fact (RNP-02's measure).
    await pagesRow.click();
    await expect(sheet).toBeVisible();
    const started = Date.now();
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(pagesRow).toContainText("12 páginas");
  } finally {
    await deleteGoal(db, personId, goalId);
    await deleteGoal(db, personId, pagesGoalId);
  }
});
