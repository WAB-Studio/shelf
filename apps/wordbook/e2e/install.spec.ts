import { expect, test } from "./fixtures";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md), which would stall every page load below before a single
// assertion runs.
async function deleteTranslator(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

test("an interrupted install leaves nothing behind, and a whole one is never fetched twice", async ({
  page,
}) => {
  await deleteTranslator(page);

  const assetPath = manifest.asset.path;
  let assetRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes(assetPath)) assetRequests++;
  });

  // Cut the payload to its first bytes: the browser sees a complete, but
  // far too small, response — the same shape a dropped connection leaves.
  await page.route(`**${assetPath}`, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    await route.fulfill({ status: 200, contentType: "application/json", body: body.subarray(0, 4096) });
  });

  await page.goto("/");
  await expect(page.getByText(messages.install.failed)).toBeVisible({ timeout: 20_000 });
  expect(assetRequests, "the truncated response is one request, not a retry loop").toBe(1);

  // RL-13: an interrupted install leaves no partial dictionary — the
  // manifest row must be absent, not merely stale.
  const manifestRow = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-dictionary");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("meta", "readonly");
          const get = tx.objectStore("meta").get("manifest");
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
      }),
  );
  expect(manifestRow).toBeUndefined();

  // Release the route and reload: a fresh boot reaches a whole file this
  // time, and the dictionary answers.
  await page.unroute(`**${assetPath}`);
  assetRequests = 0;
  await page.reload();

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 20_000 });
  expect(assetRequests, "the retry downloads the whole asset exactly once").toBe(1);

  // RL-13's other half: the next open finds the dictionary whole, and never
  // asks the network for it again.
  assetRequests = 0;
  await page.reload();
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 20_000 });
  expect(assetRequests, "a second open reads the store, not the network").toBe(0);
});
