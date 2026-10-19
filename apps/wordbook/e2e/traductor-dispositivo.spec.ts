import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// RL-08, RL-10: the device's own translator. The browser under test offers none,
// so each test installs a stand-in `Translator` before the page loads; no model
// is ever downloaded and no paid route is reached.

const SENTENCE = "I left my house yesterday";

declare global {
  interface Window {
    __translatorCreates: number;
    __emitProgress: (loaded: number) => void;
    __finishDownload: () => void;
  }
}

async function installTranslator(page: Page, availability: "available" | "downloadable"): Promise<void> {
  await page.addInitScript((mode) => {
    window.__translatorCreates = 0;
    const monitor = new EventTarget();
    let finish: () => void = () => {};
    window.__emitProgress = (loaded) => {
      const event = new Event("downloadprogress");
      Object.defineProperty(event, "loaded", { value: loaded });
      monitor.dispatchEvent(event);
    };
    window.__finishDownload = () => finish();
    (window as unknown as { Translator: unknown }).Translator = {
      availability: async () => mode,
      create: async (options: { monitor?: (target: EventTarget) => void }) => {
        window.__translatorCreates += 1;
        options.monitor?.(monitor);
        // A translator that still has to be downloaded is held until the test says it landed.
        if (mode === "downloadable") await new Promise<void>((resolve) => (finish = resolve));
        return { translate: async (text: string) => `[en el dispositivo] ${text}` };
      },
    };
  }, availability);
}

async function stubNetwork(page: Page): Promise<{ count: () => number }> {
  let count = 0;
  await page.route("**/api/translate", async (route) => {
    count++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "Traducción por red", origin: "network" }),
    });
  });
  return { count: () => count };
}

async function openReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
}

test("RL-08: a translator the browser reports available translates the sentence without asking the network", async ({
  page,
}) => {
  await installTranslator(page, "available");
  const network = await stubNetwork(page);
  await openReady(page);
  // The mount picks an available translator up on its own; wait until it has.
  await expect.poll(() => page.evaluate(() => window.__translatorCreates)).toBe(1);

  await page.getByRole("textbox", { name: messages.search.label }).fill(SENTENCE);

  await expect(page.getByText(`[en el dispositivo] ${SENTENCE}`)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.phrase.originDevice)).toBeVisible();
  await expect(page.getByText(messages.phrase.originNetwork)).toHaveCount(0);
  await expect(page.getByRole("button", { name: messages.phrase.enableDevice })).toHaveCount(0);
  expect(network.count(), "the sentence never reached the network").toBe(0);
});

// Expected to fail today: `search-screen.tsx` (schedulePhrase) sends a sentence
// to the per-word breakdown whenever `navigator.onLine` is false, before it
// looks at the device translator, so a ready on-device translator is unused
// offline. Playwright turns this red the day that is fixed; drop `test.fail`
// then.
test("RL-08: with the network off, the ready on-device translator still answers the sentence", async ({
  page,
  context,
}) => {
  test.fail();
  await installTranslator(page, "available");
  const network = await stubNetwork(page);
  await openReady(page);
  await expect.poll(() => page.evaluate(() => window.__translatorCreates)).toBe(1);
  await context.setOffline(true);

  await page.getByRole("textbox", { name: messages.search.label }).fill(SENTENCE);

  await expect(page.getByText(`[en el dispositivo] ${SENTENCE}`)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.phrase.originDevice)).toBeVisible();
  expect(network.count(), "the sentence never reached the network").toBe(0);
});

test("RL-10: while the translator downloads the interface says so, shows its progress, and the box stays usable", async ({
  page,
}) => {
  await installTranslator(page, "downloadable");
  await stubNetwork(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(SENTENCE);
  await expect(page.getByText(messages.phrase.originNetwork)).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: messages.phrase.enableDevice }).click();
  await expect(page.getByText(messages.phrase.downloadingModel)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: messages.phrase.progressLabel })).toBeVisible();

  await page.evaluate(() => window.__emitProgress(0.4));
  await expect(page.getByText(messages.phrase.downloadProgress.replace("{percent}", "40"))).toBeVisible();

  // The box still takes a word and answers it from the dictionary while the download runs.
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });
  await expect(searchBox).toBeEnabled();

  await page.evaluate(() => window.__finishDownload());
  await expect(page.getByText(messages.phrase.downloadingModel)).toHaveCount(0);

  await searchBox.fill("We drove to the coast together");
  await expect(page.getByText(messages.phrase.originDevice)).toBeVisible({ timeout: 5000 });
});
