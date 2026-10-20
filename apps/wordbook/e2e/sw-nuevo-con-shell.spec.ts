import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const SOURCE = readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md), which would stall every page load below.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function workerVersion(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) return null;
    const channel = new MessageChannel();
    const reply = new Promise<string>((resolve) => {
      channel.port1.onmessage = (event) => resolve(String(event.data));
    });
    navigator.serviceWorker.controller.postMessage("version", [channel.port2]);
    return Promise.race([reply, new Promise<string>((resolve) => setTimeout(() => resolve("silent"), 1500))]);
  });
}

// Deploy simulation: the same worker with a different version stamp. The
// browser's own update check is not routable, so the new release is a second
// `register()` of the scope with another script address, which installs a new
// worker over the open page exactly as an update would.
test("a shell open on v(n) keeps answering when v(n+1) deploys, and the next navigation is v(n+1)'s", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  const stamp = (version: string) =>
    `${SOURCE}\nself.addEventListener("message", (event) => { event.ports[0]?.postMessage(${JSON.stringify(version)}); });\n`;
  await context.route("**/sw.js**", async (route) => {
    const original = await route.fetch({ url: new URL("/sw.js", route.request().url()).href });
    await route.fulfill({
      response: original,
      body: stamp(new URL(route.request().url()).searchParams.get("v") ?? "v1"),
      headers: { ...original.headers(), "content-type": "application/javascript", "cache-control": "no-store" },
    });
  });

  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
  expect(await workerVersion(page)).toBe("v1");

  // The shell stays open through the deploy and keeps working.
  const searchBox = page.getByRole("textbox");
  await searchBox.fill("throughout");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?v=v2");
  });
  // The new worker takes the open shell over without a reload.
  await expect.poll(() => workerVersion(page), { timeout: 20_000 }).toBe("v2");
  await expect(searchBox).toHaveValue("throughout");
  await expect(searchBox).toBeEditable();

  // The next navigation is served under v(n+1): it controls the page it opens.
  await page.goto("/registro");
  await expect.poll(() => workerVersion(page), { timeout: 20_000 }).toBe("v2");
});
