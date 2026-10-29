import type { Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import plan from "../messages/es/plan.json";

// UX 313: a refusal reads under the control it is about, with that control's
// ring (`aria-invalid`), never in one line far from it; the phase form carries
// one label per field, not a section label stacked over them.

// The gap from a control's bottom edge to the sentence that refuses it.
async function gapBelow(control: Locator, sentence: Locator): Promise<number> {
  const [c, s] = await Promise.all([control.boundingBox(), sentence.boundingBox()]);
  return s!.y - (c!.y + c!.height);
}

async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

for (const viewport of [
  { width: 360, height: 780 },
  { width: 1280, height: 800 },
]) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport });

    test("a goal with no name is refused under the name field, with its ring", async ({ page }) => {
      await page.goto("/metas/nueva");
      const name = page.getByLabel("nombre");
      await page.getByRole("button", { name: "Abrirla" }).click();

      const refusal = page.getByText("Escribe un nombre.", { exact: true });
      await expect(refusal).toBeVisible();
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByLabel("final")).not.toHaveAttribute("aria-invalid", "true");
      expect(await gapBelow(name, refusal)).toBeLessThanOrEqual(8);
    });

    test("a horizon out of range is refused in the horizon's hint, in its place", async ({ page }) => {
      await page.goto("/metas/nueva");
      await page.getByLabel("nombre").fill(`Meta horizonte ${Date.now()}`);
      const horizon = page.getByLabel("final");
      await horizon.fill("9999");
      await page.getByRole("button", { name: "Abrirla" }).click();

      const refusal = page.getByText("Escribe un número entero de semanas, entre 1 y 520.");
      await expect(refusal).toBeVisible();
      await expect(horizon).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("cuántas semanas le das")).toHaveCount(0);
      expect(await gapBelow(horizon, refusal)).toBeLessThanOrEqual(8);
    });

    test("a commitment refuses each control where it is, and a phase has one label per field", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await createGoal(page, `Meta formularios ${Date.now()}`);
      try {
        await page.goto(`/metas/${goalId}/compromisos/nuevo`);
        const name = page.getByLabel("qué es");
        await page.getByRole("button", { name: "Añadirlo" }).click();
        await expect(name).toHaveAttribute("aria-invalid", "true");
        expect(await gapBelow(name, page.getByText("Escribe un nombre.", { exact: true }))).toBeLessThanOrEqual(8);

        await name.fill("Compromiso formulario");
        await page.getByRole("radio", { name: "días sueltos", exact: true }).click();
        await page.getByRole("button", { name: "Añadirlo" }).click();
        const days = page.getByText("Elige al menos un día.");
        await expect(days).toBeVisible();
        const lastDay = page.getByRole("button", { name: "domingo", exact: true }).last();
        expect(await gapBelow(lastDay, days)).toBeLessThanOrEqual(16);

        await page.getByRole("radio", { name: "todos los días", exact: true }).click();
        await page.getByRole("button", { name: "un número", exact: true }).click();
        const quantity = page.getByLabel("cantidad", { exact: true });
        await quantity.fill("999999999999");
        await page.getByLabel("unidad").fill("unidades");
        await page.getByRole("button", { name: "Añadirlo" }).click();
        await expect(quantity).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByLabel("unidad")).not.toHaveAttribute("aria-invalid", "true");
        const quantityRefusal = page.getByText("Escribe un número entero entre 1 y 1 000 000.");
        expect(await gapBelow(quantity, quantityRefusal)).toBeLessThanOrEqual(16);

        await page.goto(`/metas/${goalId}/fases/nueva`);
        await expect(page.getByText("qué semanas")).toHaveCount(0);
        await page.getByLabel(plan.phaseForm.aimLabel).fill("Objetivo");
        await page.getByLabel("desde la semana").fill("3");
        await page.getByLabel("hasta la semana").fill("2");
        await page.getByRole("button", { name: plan.phaseForm.submit }).click();
        await expect(page.getByLabel("desde la semana")).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByLabel("hasta la semana")).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByLabel(plan.phaseForm.aimLabel)).not.toHaveAttribute("aria-invalid", "true");
        expect(
          await gapBelow(page.getByLabel("hasta la semana"), page.getByText("La fase termina antes de empezar.")),
        ).toBeLessThanOrEqual(16);

        await page.getByLabel(plan.phaseForm.aimLabel).fill("");
        await page.getByLabel("desde la semana").fill("1");
        await page.getByLabel("hasta la semana").fill("2");
        await page.getByRole("button", { name: plan.phaseForm.submit }).click();
        await expect(page.getByLabel(plan.phaseForm.aimLabel)).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByLabel("desde la semana")).not.toHaveAttribute("aria-invalid", "true");
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
      }
    });
  });
}
