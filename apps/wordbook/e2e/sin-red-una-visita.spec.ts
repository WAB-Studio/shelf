import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// RL-16: one online visit is enough for the reader to look a word up with no
// connection at all. The dictionary Worker's own chunk is requested before the
// service worker controls the page, so only an install-time precache holds it.

const WIDTHS = [
  { name: "360", viewport: { width: 360, height: 740 } },
  { name: "1280", viewport: { width: 1280, height: 800 } },
] as const;

// The payload download is the event the install hangs on; the index build that
// follows is what the store poll waits out.
function payloadFetched(page: Page) {
  return page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
}

async function deleteTranslator(page: Page) {
  // Chromium's built-in `Translator` hangs `availability()` forever (docs/TRAPS.md).
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function isCached(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (p) => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      if (await cache.match(new URL(p, location.origin).toString()))
        return true;
    }
    return false;
  }, path);
}

// The dictionary's own store holds a manifest once the install has landed.
// Opening a database that does not exist yet would create it empty at version
// 1 and the worker's own open would then never build its stores, so look
// before opening.
async function dictionaryInstalled(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((db) => db.name === "reading-dictionary")) return false;
    return new Promise<boolean>((resolve) => {
      const open = indexedDB.open("reading-dictionary");
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("meta")) {
          db.close();
          resolve(false);
          return;
        }
        const count = db
          .transaction("meta", "readonly")
          .objectStore("meta")
          .count();
        count.onsuccess = () => {
          db.close();
          resolve(count.result > 0);
        };
        count.onerror = () => {
          db.close();
          resolve(false);
        };
      };
    });
  });
}

// «apple» answers as one comma-joined translation line.
function appleTranslation(page: Page) {
  return page.getByText("manzana, poma", { exact: true });
}

async function lookUpApple(page: Page) {
  await page
    .getByRole("textbox", { name: messages.search.label })
    .fill("apple");
  await expect(appleTranslation(page)).toBeVisible();
}

async function openOffline(context: BrowserContext): Promise<Page> {
  await context.setOffline(true);
  const page = await context.newPage();
  await deleteTranslator(page);
  await page.goto("/");
  return page;
}

for (const { name, viewport } of WIDTHS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("one online visit to / lets a new page answer «apple» with no connection", async ({
      page,
      context,
    }) => {
      await deleteTranslator(page);
      const fetched = payloadFetched(page);
      await page.goto("/");
      await fetched;
      await controlled(page);
      await expect.poll(() => dictionaryInstalled(page)).toBe(true);
      await lookUpApple(page);
      await page.close();

      const offline = await openOffline(context);
      await lookUpApple(offline);
      await expect(
        offline.getByText(messages.install.failed, { exact: true }),
      ).toHaveCount(0);
    });

    // `/registro` and `/cuenta` never boot the dictionary (RNL-08), so no
    // payload exists on the device after these visits and an answer is
    // impossible. What the reader is owed is the truth: the Worker loads from
    // the install-time precache, reaches for the payload, finds no network and
    // says the install failed. The Worker chunk never loading would leave
    // "Instalando…" on screen forever.
    for (const visits of [
      ["/registro", "/cuenta"],
      ["/cuenta"],
      ["/registro"],
    ] as const) {
      test(`first online visits only to ${visits.join(" then ")}: / offline says the install failed, never installing forever`, async ({
        page,
        context,
      }) => {
        await deleteTranslator(page);
        for (const route of visits) {
          await page.goto(route);
          await controlled(page);
        }
        await expect.poll(() => isCached(page, "/")).toBe(true);
        await page.close();

        const offline = await openOffline(context);
        await offline
          .getByRole("textbox", { name: messages.search.label })
          .fill("apple");
        await expect(
          offline.getByText(messages.install.failed, { exact: true }),
        ).toBeVisible();
        await expect(
          offline.getByText(messages.install.preparing, { exact: true }),
        ).toHaveCount(0);
      });
    }

    test("a Worker that cannot load says the install failed, never installing forever", async ({
      page,
      context,
    }) => {
      await deleteTranslator(page);
      await context.route(
        "**/_next/static/chunks/turbopack-worker-*",
        (route) => route.abort(),
      );
      await page.goto("/");
      await page
        .getByRole("textbox", { name: messages.search.label })
        .fill("apple");

      await expect(
        page.getByText(messages.install.failed, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(messages.install.unknownSize, { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(messages.install.preparing, { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(/Instalando el diccionario: \d+%/),
      ).toHaveCount(0);
    });
  });
}
