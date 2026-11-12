import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

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

// A card put away until `due`, as the cards store of `reading-review` keeps it, so the review finds it waiting.
async function seedCard(page: Page, card: { key: string; due: number }): Promise<void> {
  await page.evaluate(
    (card) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-review", 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("cards", { keyPath: "key" });
          request.result.createObjectStore("senses", { keyPath: "key" });
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("cards", "readwrite");
          tx.objectStore("cards").put({
            key: card.key,
            due: card.due,
            stability: 4,
            difficulty: 5,
            scheduledDays: 1,
            learningSteps: 0,
            reps: 2,
            lapses: 0,
            state: 2,
            lastReview: card.due - 86_400_000,
            introducedOn: "2026-11-02",
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    card,
  );
}

test("the review says when the next card returns in Bogota's hour, not UTC's", async ({ page }) => {
  // 16:04 in Bogota, 21:04 UTC; the card waits three hours, past the 20 minutes the session waits for.
  const now = Date.parse("2026-11-03T21:04:00.000Z");
  await page.clock.setFixedTime(now);
  await page.goto("/registro");
  await seedRecord(page, [{ at: now - 1_000, text: "snuff", translation: "rapé" }]);
  await seedCard(page, { key: "snuff", due: now + 3 * 3_600_000 });
  await page.goto("/repaso");

  const line = page.getByText(/La próxima vuelve hoy a las/);
  await expect(line).toBeVisible();
  await expect(line).toContainText("19:04");
  await expect(line).not.toContainText("00:04");
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
