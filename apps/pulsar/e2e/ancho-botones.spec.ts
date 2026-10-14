import { test, expect, visit } from "./fixtures";
import { boxOf } from "./box";

// Content stops at 1200 from 1024, and a link shaped as a button
// follows the same width rule as a `<button>` (`SistemaEspacio.dc.html`).

test("at 2000 a link-button and a button are sized to their text, never the column", async ({
  person,
  browser,
}) => {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 2000, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    for (const name of ["Abrir una meta", "Importar un plan"]) {
      const box = (await boxOf(page.getByRole("link", { name })));
      expect(box.width).toBeGreaterThanOrEqual(160);
      expect(box.width).toBeLessThan(400);
    }
    await visit(page, "/metas/nueva");
    const save = (await boxOf(page.getByRole("button", { name: "Abrirla" })));
    expect(save.width).toBeGreaterThanOrEqual(160);
    expect(save.width).toBeLessThan(400);
  } finally {
    await context.close();
  }
});

test("at 2000 a full-width screen's content stops at 1200", async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await visit(page, "/semana");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const header = (await boxOf(page.locator("main > header:visible").first()));
  expect(header.width).toBeLessThanOrEqual(1200);
});

test("at 390 a block button still spans the column", async ({ person, browser }) => {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 390, height: 800 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/");
    const box = (await boxOf(page.getByRole("link", { name: "Abrir una meta" })));
    expect(box.width).toBeGreaterThanOrEqual(349);
  } finally {
    await context.close();
  }
});

test("a block button in a sheet's actions follows the width rule: sized to text at 1280, the column at 390", async ({
  page,
  db,
  personId,
}) => {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(`Meta ancho ${Date.now()}`);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalId = page.url().split("/metas/")[1];
  try {
    const dialog = page.getByRole("dialog");
    const primary = dialog.getByRole("button", { name: "Guardarlo" });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Renombrar" }).click();
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await boxOf(primary)).width).toBeGreaterThanOrEqual(160);
    expect((await boxOf(primary)).width).toBeLessThan(240);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole("button", { name: "Renombrar" }).click();
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => {
        const sheet = (await boxOf(dialog));
        return sheet.width - (await boxOf(primary)).width;
      })
      .toBeLessThan(60);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
