import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// RL-13: a device with no room for the dictionary says the install failed, and
// stores neither half of it. The quota error is raised inside the dictionary
// worker, where the install writes, by serving the worker's script with a patch
// of `IDBObjectStore.put` in front of it.

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function fullDisk(page: Page): Promise<void> {
  await page.route("**/turbopack-worker-*.js", async (route) => {
    const response = await route.fetch();
    const patch = `
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "payload") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put.apply(this, args);
      };
    `;
    await route.fulfill({ response, body: patch + (await response.text()) });
  });
}

test("a quota error while saving the dictionary draws the install failure line, with a retry, and stores nothing", async ({
  page,
}) => {
  await deleteTranslator(page);
  await fullDisk(page);

  await page.goto("/");

  await expect(page.getByText(messages.install.failed)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: messages.install.retry })).toBeVisible();
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();

  const rows = await page.evaluate(
    () =>
      new Promise<{ manifest: unknown; payload: unknown }>((resolve, reject) => {
        const request = indexedDB.open("reading-dictionary");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          try {
            const tx = request.result.transaction(["meta", "payload"], "readonly");
            const manifest = tx.objectStore("meta").get("manifest");
            const payload = tx.objectStore("payload").get("current");
            tx.oncomplete = () => resolve({ manifest: manifest.result, payload: payload.result });
            tx.onerror = () => reject(tx.error);
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
  expect(rows).toEqual({ manifest: undefined, payload: undefined });
});
