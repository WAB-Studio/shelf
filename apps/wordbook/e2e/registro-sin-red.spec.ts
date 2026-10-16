import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { SyncState } from "../lib/log/types";
import { expect, test } from "./fixtures";

// Module 693 (RL-61, RL-16), from the contract and not from the components:
// offline, «Información» on /cuenta opens the app's own screen, and any row of
// /registro opens its word page — one the reader never opened online too —
// with the translation the device saved. Never the browser's offline page.
//
// No address is ever typed into /cuenta: the device's own `sync` row stands in
// for a session, as in `cuenta-sin-red.spec.ts`.

const MARK = (word: string) => `MARCA-GUARDADA-${word}`;
const WORDS = ["lingered", "left", "went"] as const;

for (const viewport of [
  { width: 360, height: 640 },
  { width: 1280, height: 800 },
]) {
  test.describe(`sin red, ${viewport.width}px`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      // Chromium's built-in `Translator` hangs `availability()` forever (docs/TRAPS.md).
      await page.addInitScript(() => {
        delete (window as unknown as { Translator?: unknown }).Translator;
      });
      // Next answers a tap from an RSC payload it prefetched while online, which
      // Chromium's HTTP cache can hand back offline. A device that never
      // prefetched it falls back to a full navigation, the one the worker answers.
      await page.route(/[?&]_rsc=/, (route) => route.abort());
    });

    async function controlled(page: Page): Promise<void> {
      // `ready` resolves once the worker is active, and activation waits for
      // the install, precache included.
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    }

    function notBrowserError(page: Page): void {
      expect(page.url()).not.toContain("chrome-error:");
    }

    async function seedSync(page: Page): Promise<void> {
      const sync: SyncState = {
        deviceId: randomUUID(),
        pushedThroughLocalId: null,
        pulledThroughCursor: null,
        lastSyncedAt: Date.now() - 3_600_000,
        enabled: true,
        readerId: randomUUID(),
        retired: false,
      };
      await page.evaluate(
        ({ version, sync }) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("reading-log", version);
            request.onupgradeneeded = (event) => {
              const database = request.result;
              if (event.oldVersion < 1) {
                const store = database.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
                store.createIndex("at", "at");
                store.createIndex("normalised", "normalised");
              }
              if (event.oldVersion < 2) {
                database.createObjectStore("sync", { keyPath: "key" });
                request.transaction!
                  .objectStore("lookups")
                  .createIndex("foreign", ["device", "deviceSeq"], { unique: true });
              }
              if (event.oldVersion < 3) {
                request.transaction!.objectStore("lookups").createIndex("headword", "headword");
              }
            };
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction(["sync"], "readwrite");
              tx.objectStore("sync").put({ ...sync, key: "state" });
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
          }),
        { version: DATABASE_VERSION, sync },
      );
    }

    async function goOffline(page: Page): Promise<void> {
      await page.context().setOffline(true);
      // A page its worker answers keeps `navigator.onLine` true in Chromium.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      });
    }

    async function readRows(page: Page): Promise<Array<{ normalised: string; outcome: string }>> {
      return page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("reading-log");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const getAll = db.transaction("lookups", "readonly").objectStore("lookups").getAll();
              getAll.onsuccess = () => {
                db.close();
                resolve(getAll.result);
              };
              getAll.onerror = () => reject(getAll.error);
            };
          }),
      );
    }

    // Replaces the translation a row saved with a marker only the device
    // holds: the dictionary cannot say it, so a page that shows it read the row.
    async function markTranslations(page: Page): Promise<void> {
      await page.evaluate(
        (marks) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("reading-log");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("lookups", "readwrite");
              const store = tx.objectStore("lookups");
              const all = store.getAll();
              all.onsuccess = () => {
                for (const row of all.result) {
                  const mark = marks[row.normalised];
                  if (mark !== undefined) store.put({ ...row, translation: mark });
                }
              };
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          }),
        Object.fromEntries(WORDS.map((word) => [word, MARK(word)])),
      );
    }

    // Searches the three words online, marks what they saved, and leaves the
    // page on /registro with the worker in control. No word page was opened.
    async function recordThree(page: Page): Promise<void> {
      await page.goto("/");
      await controlled(page);
      const box = page.getByRole("textbox", { name: messages.search.label });
      await expect(page.getByText(messages.install.unknownSize)).toHaveCount(0);
      await expect(page.getByText(messages.install.failed)).toHaveCount(0);
      for (const word of WORDS) {
        await box.fill(word);
        await box.fill("");
        await expect
          .poll(async () => (await readRows(page)).some((row) => row.normalised === word && row.outcome !== "miss"))
          .toBe(true);
      }
      await markTranslations(page);
      await page.goto("/registro");
    }

    function rowLinks(page: Page) {
      return page.locator('a[href^="/registro/"]');
    }

    // The typed word each row of /registro stands for, read off the row's own
    // marker, with the address it opens.
    async function rowsByWord(page: Page): Promise<Array<{ word: string; href: string }>> {
      await expect(rowLinks(page)).toHaveCount(WORDS.length);
      const found: Array<{ word: string; href: string }> = [];
      for (const word of WORDS) {
        const row = rowLinks(page).filter({ hasText: MARK(word) });
        await expect(row).toHaveCount(1);
        found.push({ word, href: (await row.getAttribute("href"))! });
      }
      return found;
    }

    // The tap landed on the word's own page: the address has committed, and
    // the list it left (which also carries the saved translation) is gone.
    async function expectWordPage(page: Page, word: string, href: string): Promise<void> {
      await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      notBrowserError(page);
      await expect(page.getByRole("link", { name: `← ${messages.log.word.back}`, exact: true })).toBeVisible();
      // The saved translation, in the subtitle: only the row holds it.
      await expect(page.getByText(MARK(word)).first()).toBeVisible();
      // The form as it was typed, among the searches listed below.
      await expect(page.getByText(word, { exact: true }).first()).toBeVisible();
      await expect(
        page.getByText(messages.log.word.emptyBody.replace("{word}", decodeURIComponent(href.split("/").pop()!))),
      ).toHaveCount(0);
    }

    test("offline, «Información» on /cuenta opens the information, never the browser's offline page", async ({
      page,
    }) => {
      await page.goto("/cuenta");
      await controlled(page);
      await seedSync(page);
      await goOffline(page);

      await page.goto("/cuenta");
      await expect(page.getByRole("heading", { name: messages.account.title }).first()).toBeVisible();
      await page.getByRole("link", { name: messages.account.info.tabs.info, exact: true }).click();

      await expect(page).toHaveURL(/\/cuenta\?tab=info$/);
      await expect(page.getByText(messages.account.info.dictionaryLabel, { exact: true })).toBeVisible();
      notBrowserError(page);
      // The account tab's own content is gone, not drawn beside it.
      await expect(page.getByText(messages.account.copy.noSessionTitle)).toHaveCount(0);
    });

    test("offline, a fresh open of /cuenta?tab=info draws the information", async ({ page }) => {
      await page.goto("/cuenta");
      await controlled(page);
      await goOffline(page);

      await page.goto("/cuenta?tab=info");
      await expect(page.getByText(messages.account.info.dictionaryLabel, { exact: true })).toBeVisible();
      notBrowserError(page);
    });

    test("offline, every row of /registro opens its word page with the translation the device saved, though it never opened online", async ({
      page,
    }) => {
      await recordThree(page);
      const rows = await rowsByWord(page);
      await goOffline(page);

      for (const { word, href } of rows) {
        await page.goto("/registro");
        await expect(rowLinks(page)).toHaveCount(WORDS.length);
        await page.locator(`a[href="${href}"]`).click();

        await expectWordPage(page, word, href);
      }
    });

    test("offline, a row whose word page was opened online still opens", async ({ page }) => {
      await recordThree(page);
      const rows = await rowsByWord(page);
      const opened = rows[0];
      await page.goto(opened.href);
      await expect(page.getByText(MARK(opened.word)).first()).toBeVisible();
      await goOffline(page);

      await page.goto("/registro");
      await page.locator(`a[href="${opened.href}"]`).click();
      await expectWordPage(page, opened.word, opened.href);
    });

    test("offline, a word page for a word not in the record says so", async ({ page }) => {
      await page.goto("/registro");
      await controlled(page);
      await goOffline(page);

      await page.goto("/registro/zzqqxv693");
      await expect(page.getByRole("heading", { name: "zzqqxv693" })).toBeVisible();
      await expect(page.getByText(messages.log.word.emptyBody.replace("{word}", "zzqqxv693"))).toBeVisible();
      notBrowserError(page);
    });

    test("offline, the tab links mark the tab the cached page is showing", async ({ page }) => {
      await page.goto("/cuenta");
      await controlled(page);
      await goOffline(page);

      const account = page.getByRole("main").getByRole("link", { name: messages.account.info.tabs.account, exact: true });
      const info = page.getByRole("main").getByRole("link", { name: messages.account.info.tabs.info, exact: true });
      await page.goto("/cuenta?tab=info");
      await expect(info).toHaveAttribute("aria-current", "page");
      await expect(account).not.toHaveAttribute("aria-current", "page");

      await account.click();
      await expect(page).toHaveURL(/\/cuenta$/);
      await expect(account).toHaveAttribute("aria-current", "page");
      await expect(info).not.toHaveAttribute("aria-current", "page");
    });

    test("the generic word shell is fetched with no session cookie", async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: "sb-session-probe", value: "reader", url: baseURL! }]);
      const carried: boolean[] = [];
      await context.route("**/registro/_", async (route) => {
        carried.push("cookie" in (await route.request().allHeaders()));
        await route.continue();
      });
      await page.goto("/");
      await controlled(page);
      await expect.poll(() => carried.length).toBeGreaterThan(0);
      expect(carried.every((has) => !has)).toBe(true);
    });
  });
}
