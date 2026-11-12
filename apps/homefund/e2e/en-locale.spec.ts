/**
 * The English screens read English (RF-46): each screen's title and primary
 * action equal `messages/en.json`'s, never a literal, so a fall back to `es`
 * fails here. Run at the phone's width, where the bottom bar's raised action is
 * the way into the quick sheet.
 */
import { expect } from "@playwright/test";

import en from "@/messages/en.json";

import { clearGroup, seedGroup, test } from "./global-setup";

test.beforeAll(async () => {
  await seedGroup();
});

test.afterAll(async () => {
  await clearGroup();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
});

test("/en Movements reads its title and offers the quick entry in English", async ({ page }) => {
  // Kills: i18n/request.ts falling back to es.
  await page.goto("/en/movements");
  await expect(page.getByRole("heading", { name: en.transactions.listTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en.nav.quickEntry, exact: true })).toBeVisible();
});

test("every bare address lands on /es, whatever the browser asks or an old cookie says (RF-218)", async ({ browser, baseURL }) => {
  // Kills: the proxy handing `accept-language` or a saved `NEXT_LOCALE` to next-intl, which sent this visitor to /en.
  const english = { "accept-language": "en-US,en;q=0.9" };
  const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, locale: "en-US", extraHTTPHeaders: english });
  const bare = await visitor.newPage();
  await bare.goto("/");
  await expect(bare).toHaveURL(/\/es(\/|$|\?)/);
  await visitor.close();

  const stale = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, locale: "en-US", extraHTTPHeaders: english });
  await stale.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const page = await stale.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/es(\/|$|\?)/);
  await stale.close();
});
