/**
 * RF-188: the iPhone home-screen app opens on its own launch image, and Safari in a
 * tab says once, until dismissed, how to add HomeFund to the home screen.
 */
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { test } from "./global-setup";

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

test("every launch image the head names is a PNG of the device's own pixels", async ({
  page,
  request,
}) => {
  await page.goto("/es");

  const links = page.locator('link[rel="apple-touch-startup-image"]');
  await expect(links).toHaveCount(24);
  const href = await links
    .and(page.locator('[media*="device-width: 393px"][media*="dark"]'))
    .getAttribute("href");
  expect(href).toBe("/splash/393x852-3-dark.png");

  const image = await request.get(href ?? "");
  expect(image.headers()["content-type"]).toBe("image/png");
  const bytes = await image.body();
  // A PNG's IHDR holds the width and height as big-endian words at 16 and 20.
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1179, 2556]);
});

test.describe("in Safari on an iPhone", () => {
  test.use({ userAgent: SAFARI_IPHONE });

  test("the add-to-home hint shows until dismissed, across a reload @mobile", async ({
    page,
  }) => {
    await page.goto("/es");
    await page.evaluate(() => localStorage.removeItem("install-hint-dismissed"));
    await page.reload();

    const hint = page.getByRole("note", { name: messages.installHint.title });
    await expect(hint.getByText(messages.installHint.steps)).toBeVisible();

    await hint.getByRole("button", { name: messages.installHint.dismiss }).click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(messages.installHint.steps)).toHaveCount(0);
  });
});

test("a browser that is not iOS Safari is never shown the hint @mobile", async ({ page }) => {
  await page.goto("/es");
  await expect(page.getByText(messages.installHint.steps)).toHaveCount(0);
});
