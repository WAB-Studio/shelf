import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

// Read off the worker itself: a name written here a third time would drift.
const CACHE_NAME = /const CACHE_NAME = "([^"]+)"/.exec(
  readFileSync(path.join(__dirname, "../public/sw.js"), "utf8"),
)![1];

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md), which would stall every page load below.
async function controlled(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
}

async function cached(page: Page, url: string): Promise<boolean> {
  return page.evaluate(async (target) => (await caches.match(target)) !== undefined, url);
}

test("activate deletes a cache an older worker left, and keeps the worker's own", async ({ page }) => {
  await controlled(page);
  await page.evaluate(async () => {
    const stale = await caches.open("reading-shell-v12");
    await stale.put("/registro", new Response("an older shell"));
  });
  // A new worker has to install and activate again: drop this one and reopen.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([CACHE_NAME]);
});

test("a navigation to /auth/ never reaches the cache, offline it fails as the network fails", async ({
  page,
  context,
}) => {
  await controlled(page);
  const target = "/auth/confirm?token_hash=x&type=magiclink";
  // The shell the worker would fall back to, if it answered this address.
  await page.evaluate(
    async ({ name, url }) => (await caches.open(name)).put(url, new Response("<h1>cached shell</h1>")),
    { name: CACHE_NAME, url: target },
  );

  await context.setOffline(true);
  await expect(page.goto(target)).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
});

test("a navigation to /dictionary/ is left to the browser, the worker stores nothing for it", async ({ page }) => {
  await controlled(page);
  const dictionary = "/dictionary/manifest.json";
  const sentinel = "/registro/sentinel";

  await page.goto(dictionary);
  // The worker handles one navigation after another; the sentinel's entry
  // landing means the dictionary's, had the worker kept it, has landed too.
  await page.goto(sentinel);
  await expect.poll(() => cached(page, sentinel)).toBe(true);

  expect(await cached(page, dictionary)).toBe(false);
});

test("a navigation the network holds is answered from the cached shell, not waited for", async ({
  page,
  context,
}) => {
  await controlled(page);

  // `context.route`, not `page.route`: only it reaches the worker's own fetch.
  const open: Array<() => Promise<void>> = [];
  let reach: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  await context.route(
    (url) => url.pathname === "/" && url.search === "",
    (route) => {
      open.push(() => route.abort().catch(() => {}));
      reach();
    },
  );

  await page.goto("/", { timeout: 6_000 });
  await reached;

  // The shell drew while the network request is still open.
  await expect(page.getByRole("textbox")).toBeVisible();
  await Promise.all(open.map((release) => release()));
});
