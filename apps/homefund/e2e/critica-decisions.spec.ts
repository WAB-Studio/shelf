/**
 * The deploy critic's findings the user decided: Reportes reads any month, and
 * Planeación draws the desktop's tiles in one column on the phone.
 */
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { test } from "./global-setup";

test("Reportes steps back a month and names it", async ({ page }) => {
  await page.goto("/es/reports");
  const previous = page.getByRole("button", { name: messages.common.previousMonth }).locator("visible=true").first();
  await previous.click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(page.getByRole("button", { name: messages.common.nextMonth }).locator("visible=true").first()).toBeEnabled();
});

test("Planeación draws its tiles in one column on the phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/es/planning");
  const tiles = page.locator("main a[href*='/planning/']").locator("visible=true");
  const first = await tiles.nth(0).boundingBox();
  const second = await tiles.nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y);
  expect(Math.abs(second!.x - first!.x)).toBeLessThan(2);
});
