import type { Page } from "@playwright/test";

import { test, expect, visit } from "./fixtures";
import plan from "../messages/es/plan.json";
import { boxOf } from "./box";

// UX 362: chips and paired fields are spaced by `ChipRow` and `FieldPair`,
// never by `Flex gap` or an inline `style`.

const root = (page: Page, label: string, exact = false) =>
  page.getByLabel(label, { exact }).locator("xpath=ancestor::div[contains(@class,'rt-TextFieldRoot')][1]");

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

    test("chips sit 8 apart, weekday chips 4, the quantity is 88 wide beside its unit", async ({ page }) => {
      const goalId = await createGoal(page, `Meta fila ${Date.now()}`);
      await visit(page, `/metas/${goalId}/compromisos/nuevo`);

      const gap = async (a: string, b: string) => {
        const [x, y] = await Promise.all([
          page.getByRole("radio", { name: a, exact: true }).boundingBox(),
          page.getByRole("radio", { name: b, exact: true }).boundingBox(),
        ]);
        return y!.x - (x!.x + x!.width);
      };

      await page.getByRole("radio", { name: "días sueltos", exact: true }).click();
      const days = page.getByRole("button", { pressed: false }).filter({ hasText: /^[LMXJVSD]$/ });
      const [d1, d2] = await Promise.all([days.nth(0).boundingBox(), days.nth(1).boundingBox()]);
      expect(Math.round(d2!.x - (d1!.x + d1!.width))).toBe(4);

      await page.getByRole("button", { name: "un número", exact: true }).click();
      const done = await Promise.all([
        page.getByRole("button", { name: plan.commitmentForm.satisfaction.tap, exact: true }).boundingBox(),
        page.getByRole("button", { name: "un número", exact: true }).boundingBox(),
      ]);
      expect(Math.round(done[1]!.x - (done[0]!.x + done[0]!.width))).toBe(8);
      expect(Math.round(await gap("todos los días", "días sueltos"))).toBe(8);

      const quantity = await root(page, "cantidad", true).boundingBox();
      const unit = await root(page, "unidad", true).boundingBox();
      expect(Math.round(quantity!.width)).toBe(88);
      expect(Math.round(unit!.x - (quantity!.x + quantity!.width))).toBe(8);
    });

    test("a long unbreakable unit beside the quantity never widens the page", async ({ page, db, personId }) => {
      const unit = "kilometros".repeat(8);
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
        values (${personId}, ${`Meta unidad larga ${Date.now()}`}, (now() + interval '90 days')::date, 'recorrido', ${unit})
        returning id
      `;
      try {
        await page.goto(`/metas/${goal.id}/compromisos/nuevo`);
        await page.getByRole("button", { name: "un número", exact: true }).click();
        await expect(page.getByTestId("commitment-unit")).toHaveText(unit);
        const view = page.viewportSize()!.width;
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view);
        const long = (await boxOf(page.getByTestId("commitment-unit")));
        expect(long.x + long.width).toBeLessThanOrEqual(view);
      } finally {
        await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
      }
    });

    test("the cadence chips wrap inside the page at 360 and none leaves it", async ({ page }) => {
      const goalId = await createGoal(page, `Meta chips ${Date.now()}`);
      await visit(page, `/metas/${goalId}/compromisos/nuevo`);
      const first = (await boxOf(page.getByRole("radio", { name: "todos los días", exact: true })));
      const last = (await boxOf(page.getByRole("radio", { name: plan.commitmentForm.cadence.times_per_month, exact: true })));
      const view = page.viewportSize()!.width;
      expect(last.x + last.width).toBeLessThanOrEqual(view);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(view);
      // Five chips are wider than the phone's line: the last stands on a row below the first.
      if (view < 500) expect(last.y).toBeGreaterThan(first.y + first.height - 1);
    });

    test("the phase weeks share the width evenly, 8 apart", async ({ page }) => {
      const goalId = await createGoal(page, `Meta fases ${Date.now()}`);
      await page.goto(`/metas/${goalId}/fases/nueva`);
      await expect(page.getByLabel(plan.phaseForm.fromLabel)).toBeVisible();
      const from = await root(page, "desde la semana").boundingBox();
      const to = await root(page, "hasta la semana").boundingBox();
      expect(Math.abs(from!.width - to!.width)).toBeLessThanOrEqual(1);
      expect(Math.round(to!.x - (from!.x + from!.width))).toBe(8);
    });
  });
}
