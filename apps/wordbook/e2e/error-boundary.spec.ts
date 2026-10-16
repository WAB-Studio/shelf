import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// `app/error.tsx`'s own criterion (docs/voyager/DESIGN.md "Settled"): a
// render that throws below the root layout leaves `error.title` and
// `error.retry` on screen, the shell still mounted around them, and
// `reset()` recovers the segment with no network round trip and no reload.

// `lib/log/record.ts`'s own store, written to directly — this runs inside
// `page.evaluate`, a browser context no Node import reaches, the same way
// `estudio.spec.ts` seeds it. `text` is an object here on purpose: React
// throws rendering a non-string child, which is what turns a corrupt local
// row into the render failure this suite drives — no source file changes,
// only data a future schema bug could plausibly leave behind.
async function seedCorruptRow(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
          store.createIndex("at", "at");
          store.createIndex("normalised", "normalised");
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          tx.objectStore("lookups").add({
            schema: 2,
            at: Date.now(),
            text: { corrupt: true },
            normalised: "corrupt",
            kind: "word",
            outcome: "exact",
            // The headword is the title /registro draws; an object there is the child React refuses.
            headword: { corrupt: true },
            rule: null,
            senses: 1,
            translation: null,
            dictionaryReady: true,
            origin: null,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

async function clearRows(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          tx.objectStore("lookups").clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

test("a corrupt row crashes /registro, and the bar stays reachable", async ({ page }) => {
  await page.goto("/");
  await seedCorruptRow(page);
  await page.goto("/registro");

  await expect(page.getByText(messages.error.title)).toBeVisible();
  const retry = page.getByRole("button", { name: messages.error.retry });
  await expect(retry).toBeVisible();

  // The bar's three destinations, still reachable from the fallback —
  // `Page` mounts its own `BottomNav`, so the crash below it never takes
  // the shell down too.
  const nav = page.getByRole("navigation", { name: messages.nav.label });
  await expect(nav.getByRole("link", { name: messages.nav.search })).toBeVisible();
  await expect(nav.getByRole("link", { name: messages.nav.account })).toBeVisible();

  // A marker on `window` that only a full navigation would clear: leaving
  // for `/` from the crashed screen must be a client-side transition, not
  // a reload standing in for the shell that is supposed to stay put.
  await page.evaluate(() => {
    (window as unknown as { __probe: string }).__probe = "still-here";
  });
  await nav.getByRole("link", { name: messages.nav.search }).click();
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __probe?: string }).__probe)).toBe("still-here");
});

test("the sidebar stays too, past 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await seedCorruptRow(page);
  await page.goto("/registro");

  await expect(page.getByText(messages.error.title)).toBeVisible();
  const nav = page.getByRole("navigation", { name: messages.nav.label });
  await expect(nav.getByRole("link", { name: messages.nav.log })).toBeVisible();
});

test("retry recovers the segment with no reload, once the row is gone", async ({ page }) => {
  await page.goto("/");
  await seedCorruptRow(page);
  await page.goto("/registro");
  await expect(page.getByText(messages.error.title)).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __probe: string }).__probe = "still-here";
  });

  // The fix is not what is under test here — the row a reader can never
  // edit by hand is what a real recovery would need gone first, the same
  // way a transient failure clears on its own before a retry helps.
  await clearRows(page);
  await page.getByRole("button", { name: messages.error.retry }).click();

  await expect(page.getByText(messages.log.study.emptyTitle)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __probe?: string }).__probe)).toBe("still-here");
});
