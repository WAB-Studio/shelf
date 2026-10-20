import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// RL-12, RL-13: an install whose connection drops mid-way says so, leaves no
// dictionary behind, and "Reintentar" fetches the whole file again from byte 0.

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function manifestRow(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-dictionary");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const get = request.result.transaction("meta", "readonly").objectStore("meta").get("manifest");
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

test("an install cut by the network going off says so, keeps nothing, and the retry fetches the whole file again", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  const assetPath = manifest.asset.path;

  const ranges: Array<string | undefined> = [];
  page.on("request", (request) => {
    if (request.url().includes(assetPath)) ranges.push(request.headers()["range"]);
  });

  // The request is held until the connection is gone, then dies with it.
  const asked = Promise.withResolvers<void>();
  const cut = Promise.withResolvers<void>();
  await page.route(`**${assetPath}`, async (route) => {
    asked.resolve();
    await cut.promise;
    await route.abort("internetdisconnected");
  });

  await page.goto("/");
  await asked.promise;
  await expect(page.locator('[aria-busy="true"]').first()).toBeAttached();
  await context.setOffline(true);
  cut.resolve();

  await expect(page.getByText(messages.install.failed)).toBeVisible({ timeout: 20_000 });
  const retry = page.getByRole("button", { name: messages.install.retry });
  await expect(retry).toBeVisible();
  expect(await manifestRow(page), "a cut install leaves no manifest row (RL-13)").toBeUndefined();

  // The connection returns; the retry starts from zero, never from where it stopped.
  await context.setOffline(false);
  await page.unroute(`**${assetPath}`);
  const whole = page.waitForResponse((response) => response.url().includes(assetPath) && response.ok());
  await retry.click();
  await whole;

  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByText(messages.install.failed)).toHaveCount(0);
  expect(ranges, "two requests, neither a partial one: no resume from a byte offset").toEqual([undefined, undefined]);
  expect(await manifestRow(page)).toBeDefined();

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 10_000 });
});
