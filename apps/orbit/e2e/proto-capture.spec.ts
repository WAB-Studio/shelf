// THROWAWAY: captures the cuadre prototype boards.
import { mkdirSync } from "node:fs";

import { expect } from "@playwright/test";

import { test } from "./global-setup";

const OUT = "/home/cxrkeyb/projects/finances-app/private/tableros-cuadre";
mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 390, height: 900 }, hasTouch: true, locale: "es-CO" });

const dialogs: [string, string, string][] = [
  ["B1", "Cuadrar-vacio", "B1"],
  ["B2", "Cuadrar-sobra", "B2"],
  ["B3", "Cuadrar-falta", "B3"],
  ["B4", "Cuadrar-cuadra", "B4"],
  ["B5", "Cuadrar-guardando", "B5"],
  ["B5b", "Cuadrar-rechazado-vacio", "B5b"],
  ["B5b", "Cuadrar-rechazado-obsoleto", "B5b-stale"],
  ["B6", "Cuadres-vacio", "B6"],
  ["B7", "Cuadres-lleno", "B7"],
];

for (const [id, name, key] of dialogs) {
  test(`${id} ${name}`, async ({ page }) => {
    await page.goto(`/es/settings/accounts?cuadre=${key}`);
    await page.getByRole("button", { name: /Acciones de|actions/i }).first().click();
    await page.getByRole("menuitem", { name: "Cuadrar" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${id}-${name}-390.png` });
  });
}

test("B8 menu", async ({ page }) => {
  await page.goto("/es/settings/accounts");
  await page.getByRole("button", { name: /Acciones de|actions/i }).first().click();
  await expect(page.getByRole("menuitem", { name: "Cuadrar" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/B8-Cuentas-menu-de-la-fila-390.png` });
});

const boards: [string, string][] = [
  ["B9", "Movimientos-fila-de-descuadre"],
  ["B10", "Movimientos-detalle-de-descuadre"],
  ["B11", "Inicio-mes-con-descuadre"],
  ["B12", "Reportes-descuadre-del-mes"],
];
for (const [id, name] of boards) {
  test(`${id} ${name}`, async ({ page }) => {
    await page.goto(`/es/proto?b=${id}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${id}-${name}-390.png`, fullPage: true });
  });
}
