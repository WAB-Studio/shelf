import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// Every time and day reads in the device's zone, never the server's UTC. The browser runs in Bogota (UTC-5).
test.use({ timezoneId: "America/Bogota", locale: "es-CO" });

async function seedRecord(page: Page, rows: { at: number; text: string; translation: string }[]): Promise<void> {
  await page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log", 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          const store = db.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
          store.createIndex("at", "at");
          store.createIndex("normalised", "normalised");
          db.createObjectStore("sync", { keyPath: "key" });
          store.createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          store.createIndex("headword", "headword");
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          for (const row of rows) {
            tx.objectStore("lookups").add({
              schema: 2,
              at: row.at,
              text: row.text,
              normalised: row.text.toLowerCase(),
              kind: "word",
              outcome: "exact",
              headword: row.text,
              rule: null,
              senses: 1,
              translation: row.translation,
              dictionaryReady: true,
              origin: null,
            });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    rows,
  );
}

test("the review says when the next card returns in Bogota's hour, not UTC's", async ({ page }) => {
  // 16:04 in Bogota, 21:04 UTC.
  const now = Date.parse("2026-11-03T21:04:00.000Z");
  await page.clock.setFixedTime(now);
  await page.goto("/registro");
  await seedRecord(page, [{ at: now - 1_000, text: "snuff", translation: "rapé" }]);
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.good}`) }).click();

  const line = page.getByText(/La próxima vuelve hoy a las/);
  await expect(line).toBeVisible();
  await expect(line).toContainText("16:14");
  await expect(line).not.toContainText("21:14");
});

test("the diary files an 20:30 Thursday search under Thursday, not UTC's Friday", async ({ page }) => {
  const now = Date.parse("2026-11-03T21:04:00.000Z");
  await page.clock.setFixedTime(now);
  await page.goto("/registro");
  // Thursday 29 October 2026, 20:30 in Bogota = Friday 01:30 UTC.
  await seedRecord(page, [{ at: Date.parse("2026-10-30T01:30:00.000Z"), text: "snuff", translation: "rapé" }]);
  await page.reload();

  await expect(page.getByText(/jueves,? 29 oct/i)).toBeVisible();
  await expect(page.getByText(/viernes/i)).toHaveCount(0);
});
