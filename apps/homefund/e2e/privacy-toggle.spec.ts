/**
 * «Hide amounts» (RF-174): one switch hides every figure on the device, keeps them
 * hidden across a reload and shows them again on a second press.
 */
import { expect, type Page } from "@playwright/test";

import { AMOUNT_MASK } from "@/lib/privacy";
import messages from "@/messages/es.json";

import { clearLedger, seedUnreviewedMovement, test } from "./global-setup";

// The seeded movement is 1.500.000 cents: fifteen thousand pesos.
const MOVEMENT_FIGURE = /15\.000/;

test.beforeAll(async () => {
  await seedUnreviewedMovement();
});

test.afterAll(async () => {
  await clearLedger();
});

// Inicio carries the switch in the hero and in the shell; either is the same one.
function toggle(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).locator("visible=true").first();
}

test("the toggle masks the net worth and a movement, survives a reload and shows them again", async ({
  page,
}) => {
  await page.goto("/es");
  const net = page.locator('[data-card="net"]');
  await expect(net).toContainText("$");
  await expect(page.locator("body")).toContainText(MOVEMENT_FIGURE);

  await toggle(page, messages.privacy.hide).click();
  await expect(net).toContainText(AMOUNT_MASK);
  await expect(page.locator("body")).not.toContainText(MOVEMENT_FIGURE);

  await page.reload();
  await expect(toggle(page, messages.privacy.show)).toBeVisible();
  await expect(net).toContainText(AMOUNT_MASK);
  await expect(page.locator("body")).not.toContainText(MOVEMENT_FIGURE);

  await toggle(page, messages.privacy.show).click();
  await expect(net).not.toContainText(AMOUNT_MASK);
  await expect(page.locator("body")).toContainText(MOVEMENT_FIGURE);
});
