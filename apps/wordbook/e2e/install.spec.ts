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

// ---------------------------------------------------------------------------
// The install line (docs/wordbook/DESIGN.md «Boards of 2026-10-18»): drawn
// only once installing starts. Booting says nothing, and `aria-busy` on the
// status region is the signal a reader — and a spec — waits for.
// ---------------------------------------------------------------------------

const INSTALL_LINE = /Instalando el diccionario/;

// The markup the server drew, without the scripts that carry every message
// as data.
async function drawnBy(request: import("@playwright/test").APIRequestContext, url: string): Promise<string> {
  return (await (await request.get(url)).text()).replace(/<script[\s\S]*?<\/script>/g, "");
}

test("booting draws no install line, and aria-busy is true until the dictionary is ready", async ({
  page,
  request,
}) => {
  // The server render is `booting`: the raw HTML is the state, undisturbed.
  const html = await drawnBy(request, "/");
  expect(html).not.toMatch(INSTALL_LINE);
  expect(html).toContain('aria-busy="true"');

  await deleteTranslator(page);
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  // First open installs the dictionary, so the next one finds it on the device.
  await page.goto("/");
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached({ timeout: 30_000 });
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible();

  // Every mutation from the first byte on: the line is never drawn once.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __installLines: string[] }).__installLines = seen;
    const look = () => {
      // innerText leaves the scripts out, which carry every message as data.
      if (/Instalando el diccionario/.test(document.body?.innerText ?? "")) seen.push("line");
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener("DOMContentLoaded", look);
  });
  await page.goto("/");
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached({ timeout: 30_000 });
  const lines = await page.evaluate(() => (window as unknown as { __installLines: string[] }).__installLines);
  expect(lines, "the install line was drawn on an open that installs nothing").toEqual([]);
});

test("a fresh profile shows the progress line while installing, and aria-busy stays true", async ({ page }) => {
  await deleteTranslator(page);
  const assetPath = manifest.asset.path;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${assetPath}`, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");

  await expect(page.getByText(INSTALL_LINE).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-busy="true"]').first()).toBeAttached();
  await expect(page.locator('[aria-busy="false"]')).toHaveCount(0);

  release();
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByText(INSTALL_LINE)).toHaveCount(0);
});

test("booting with a typed query still says the search will be answered once installed", async ({ request }) => {
  const html = await drawnBy(request, "/?q=book");
  expect(html).toContain(messages.install.pending.replace("{query}", "book"));
  expect(html).not.toMatch(INSTALL_LINE);
});
