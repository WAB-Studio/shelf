import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

type SeedRow = { at: number; text: string; translation: string | null; kind?: "word" | "phrase" };

// The record as `record.ts` keeps it (DATABASE_VERSION 3), written before the review opens.
async function seedRecord(page: Page, rows: SeedRow[]): Promise<void> {
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
            const kind = row.kind ?? "word";
            tx.objectStore("lookups").add({
              schema: 2,
              at: row.at,
              text: row.text,
              normalised: row.text.toLowerCase(),
              kind,
              outcome: kind === "word" ? "exact" : "translated",
              headword: kind === "word" ? row.text : null,
              rule: null,
              senses: kind === "word" ? 1 : 0,
              translation: row.translation,
              dictionaryReady: true,
              origin: kind === "phrase" ? "network" : null,
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

const now = Date.now();
const RECORD: SeedRow[] = [
  { at: now - 3_000, text: "snuff", translation: "rapé" },
  { at: now - 2_000, text: "snuff", translation: "rapé" },
  { at: now - 1_000, text: "frisk", translation: "cachear" },
  { at: now - 500, text: "give it up", translation: "ríndete", kind: "phrase" },
];

test("RL-68, RL-78: /registro opens the review, which asks each word and each translated phrase of the record", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD);
  await page.reload();
  await page.getByRole("link", { name: messages.review.open }).click();
  await expect(page).toHaveURL(/\/repaso$/);

  // The most looked-up word first, then the newest entries: three in all, the phrase among them.
  await expect(page.getByText("1 de 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "snuff" })).toBeVisible();
  await expect(page.getByText(messages.review.newWord)).toBeVisible();
  await expect(page.getByText("rapé", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: messages.review.show }).click();
  await expect(page.getByText("rapé", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();

  await expect(page.getByText("2 de 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "give it up" })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await expect(page.getByText("ríndete", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();

  await expect(page.getByText("3 de 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "frisk" })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();

  // A phrase is among them, so the screen counts entries, not words.
  await expect(page.getByText("Repasaste 3 entradas. Terminaste por hoy.")).toBeVisible();
  await expect(page.getByText("3 entradas vuelven más adelante.")).toBeVisible();
});

test("RL-68: a keyboard keeps its place: showing the answer focuses «Bien», a grade focuses the next «Mostrar respuesta»", async ({
  page,
}) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD);
  await page.goto("/repaso");
  await expect(page.getByRole("button", { name: messages.review.show })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: new RegExp(`^${messages.review.grade.good}`) })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "give it up" })).toBeVisible();
  await expect(page.getByRole("button", { name: messages.review.show })).toBeFocused();
});

test("RL-68: the answers are kept on the device, so a word put away does not come back on a reload", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD);
  await page.goto("/repaso");
  for (const name of ["snuff", "give it up", "frisk"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await page.getByRole("button", { name: messages.review.show }).click();
    await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();
  }

  await page.reload();
  await expect(page.getByText("Hoy no tienes entradas por repasar.")).toBeVisible();
  await expect(page.getByText("3 entradas vuelven más adelante.")).toBeVisible();
});

test("RL-78: «Otra vez» puts the entry back in the same session instead of ending it", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.again}`) }).click();

  await expect(page.getByText("Queda 1 palabra para repetir en un momento.")).toBeVisible();
  await expect(page.getByText(/Terminaste por hoy/)).toHaveCount(0);
  await page.getByRole("button", { name: messages.review.reviewNow }).click();
  await expect(page.getByRole("heading", { name: "frisk" })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();
  await expect(page.getByText("Repasaste 1 palabra. Terminaste por hoy.")).toBeVisible();
});

test("RL-68: each answer names how long it puts the word away before it is pressed", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  const grades = page.getByRole("button", { name: /min|h|día/ });
  await expect(grades).toHaveCount(4);
  await expect(page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}.*día`) })).toBeVisible();
});

test("RL-68, RL-91: with an empty record the review says where its words come from and points at searching", async ({ page }) => {
  await page.goto("/repaso");
  await expect(page.getByText("Hoy no tienes palabras por repasar.")).toBeVisible();
  await expect(page.getByText(messages.review.empty)).toBeVisible();
  // The record is empty too: the way forward is the search, not another empty screen.
  await expect(page.getByRole("link", { name: messages.review.searchWord })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: messages.review.backToRecord })).toHaveCount(0);
});

test("RL-91: a record that holds entries, none to ask today, still leads to the record", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.easy}`) }).click();
  await expect(page.getByRole("link", { name: messages.review.backToRecord })).toHaveAttribute("href", "/registro");
  await expect(page.getByRole("link", { name: messages.review.searchWord })).toHaveCount(0);
});

test("RL-91: a learning step within 20 minutes keeps the session open, naming when one comes back", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  // «Bien» on a new word is the 10 minute step.
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.good}`) }).click();

  await expect(page.getByText("Queda 1 palabra para repetir en un momento.")).toBeVisible();
  await expect(page.getByText("Vuelve una en 10 min")).toBeVisible();
  await expect(page.getByText(/Terminaste por hoy/)).toHaveCount(0);
});

test("RL-91: after a reload the entry due a minute later is still asked, not lost", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.again}`) }).click();
  await expect(page.getByText("Queda 1 palabra para repetir en un momento.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Queda 1 palabra para repetir en un momento.")).toBeVisible();
  await expect(page.getByText(/Vuelve una en 1 min/)).toBeVisible();
  await expect(page.getByText(/Hoy no tienes/)).toHaveCount(0);
  await expect(page.getByText(/Terminaste por hoy/)).toHaveCount(0);
});

test("RL-91: the waiting entry shows by itself when its step comes, with no reload", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, RECORD.slice(2, 3));
  await page.clock.install();
  await page.goto("/repaso");
  await page.getByRole("button", { name: messages.review.show }).click();
  await page.getByRole("button", { name: new RegExp(`^${messages.review.grade.good}`) }).click();
  await expect(page.getByText("Vuelve una en 10 min")).toBeVisible();

  await page.clock.fastForward(11 * 60_000);
  await expect(page.getByRole("heading", { name: "frisk" })).toBeVisible();
  await expect(page.getByText(messages.review.repeat, { exact: true })).toBeVisible();
});

test("RL-91: with no tap, «tree» is asked as the noun «árbol», not as the verb «enarbolar»", async ({ page }) => {
  await page.goto("/registro");
  await seedRecord(page, [{ at: now, text: "tree", translation: "enarbolar, árbol, fuste" }]);
  await page.goto("/repaso");
  await expect(page.getByRole("heading", { name: "tree", exact: true })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await expect(page.getByText(messages.word.pos.n, { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/árbol/).first()).toBeVisible();
  await expect(page.getByText(/enarbolar/)).toHaveCount(0);
});
