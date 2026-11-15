/**
 * HomeFund is Spanish alone (RF-221, RF-218): `/en` redirects to `/es` and no
 * browser language or old cookie picks another. Run at the phone's width.
 */
import { expect } from "@playwright/test";

import es from "@/messages/es.json";

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

test("every /en address redirects to the same path under /es, query string kept (RF-221)", async ({ page }) => {
  // Kills: an English screen answering, a dropped query string, a redirect that loops.
  await page.goto("/en/movements?q=cafe");
  await expect(page).toHaveURL(/\/es\/movements\?q=cafe$/);
  await expect(page.getByRole("heading", { name: es.transactions.listTitle, exact: true })).toBeVisible();

  await page.goto("/en");
  await expect(page).toHaveURL(/\/es$/);
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
