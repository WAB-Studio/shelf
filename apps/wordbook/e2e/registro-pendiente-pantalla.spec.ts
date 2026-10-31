import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

import messages from "../messages/es.json";
import type { LookupRecord } from "../lib/log/types";
import { DATABASE_VERSION } from "../lib/log/record";

// RL-76 on the screens that read the record: `/registro` and the word page
// (boards RegistroPendiente, PalabraPendiente, docs/wordbook/DESIGN.md, boards
// of 2026-10-18). The sentences below are the board's, character for character,
// not the catalog's keys: a renamed key must not move what the reader reads.
const WAITING = "Sin respuesta todavía";
const WORD_LINE = "El diccionario no la tiene y aún no hay respuesta. Se vuelve a pedir una vez al día, con conexión.";
const PHRASE_LINE = "La traducción no llegó. Se vuelve a pedir una vez al día, con conexión.";
const PAGE_TITLE = "Esta búsqueda espera respuesta";
const PAGE_BODY = "No hubo respuesta cuando la buscaste: faltaba la conexión o el servicio no contestó. Se vuelve a pedir una vez al día, con conexión, y su traducción aparece aquí.";
const SEARCHES = "Búsquedas";

type Seed = Omit<LookupRecord, "id">;

const NOW = Date.now();

// The payload M19's `record.ts` stores for a pending row: schema 4, no
// translation, no headword, no `device`.
function pending(text: string, at: number, kind: "word" | "phrase" = "word"): Seed {
  return {
    schema: 4,
    at,
    text,
    normalised: text.toLowerCase(),
    kind,
    outcome: kind === "word" ? "miss" : "untranslated",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
  };
}

function answered(word: string, translation: string, at: number): Seed {
  return {
    schema: 4,
    at,
    text: word,
    normalised: word,
    kind: "word",
    outcome: "exact",
    headword: word,
    rule: null,
    senses: 1,
    translation,
    dictionaryReady: true,
    origin: "device",
  };
}

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// A drain that runs on load asks these two routes; a 204 leaves the row
// pending, so the screen under test is the one the seed drew.
async function keepNetworkSilent(page: Page): Promise<void> {
  await page.route("**/api/translate", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/word/unlisted", (route) => route.fulfill({ status: 204, headers: { "x-e2e-word-stub": "1" } }));
}

async function seed(page: Page, rows: Seed[]): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  await page.evaluate(
    ({ version, lookups }) =>
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
          const tx = db.transaction("lookups", "readwrite");
          for (const lookup of lookups) tx.objectStore("lookups").add(lookup);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, lookups: rows },
  );
}

async function openRegistro(page: Page, rows: Seed[]): Promise<void> {
  await deleteTranslator(page);
  await keepNetworkSilent(page);
  await seed(page, rows);
  await page.goto("/registro");
  await expect(page.getByRole("heading", { name: messages.log.title })).toBeVisible();
}

// A row is a card holding the word's link, its translation and its waiting lines.
const rowOf = (page: Page, text: string): Locator =>
  page
    .locator("section")
    .filter({ has: page.getByRole("link").filter({ has: page.getByText(text, { exact: true }) }) });

// Study order: count desc, then most recent. zzorble twice, then the sentence,
// alpha, mango: a waiting group sits among the answered ones, not after them.
const ROWS = (): Seed[] => [
  answered("mango", "mango", NOW - 40),
  answered("alpha", "alfa", NOW - 30),
  pending("the cat sits still", NOW - 20, "phrase"),
  pending("zzorble", NOW - 15),
  pending("zzorble", NOW - 10),
];

test("RL-76: a pending word reads «Sin respuesta todavía» and «Se responde sola…», with its count and no translation", async ({
  page,
}) => {
  await openRegistro(page, ROWS());
  const row = rowOf(page, "zzorble");
  await expect(row).toHaveCount(1);
  await expect(row.getByText(WAITING, { exact: true })).toBeVisible();
  await expect(row.getByText(WORD_LINE, { exact: true })).toBeVisible();
  await expect(row.getByText("2 veces", { exact: true })).toBeVisible();
  await expect(row.getByText(PHRASE_LINE)).toHaveCount(0);
  // It is not drawn as a miss: no «sin resultado», no form list.
  await expect(row.getByText(messages.log.study.noResult)).toHaveCount(0);
  await expect(row.getByText(/sin resultado/i)).toHaveCount(0);
});

test("RL-76: a pending sentence says «Se traduce sola…», not «Se responde sola…»", async ({ page }) => {
  await openRegistro(page, ROWS());
  const row = rowOf(page, "the cat sits still");
  await expect(row.getByText(WAITING, { exact: true })).toBeVisible();
  await expect(row.getByText(PHRASE_LINE, { exact: true })).toBeVisible();
  await expect(row.getByText(WORD_LINE)).toHaveCount(0);
});

test("RL-76: an answered row beside them is unchanged, and the order is the usual one", async ({ page }) => {
  await openRegistro(page, ROWS());
  const alpha = rowOf(page, "alpha");
  await expect(alpha.getByText("alfa", { exact: true })).toBeVisible();
  await expect(alpha.getByText(WAITING)).toHaveCount(0);
  await expect(alpha.getByText(WORD_LINE)).toHaveCount(0);
  await expect(alpha.getByText(PHRASE_LINE)).toHaveCount(0);

  const ys = async (text: string) => (await rowOf(page, text).boundingBox())!.y;
  const [zzorble, sentence, alphaY, mango] = [
    await ys("zzorble"),
    await ys("the cat sits still"),
    await ys("alpha"),
    await ys("mango"),
  ];
  expect(zzorble).toBeLessThan(sentence);
  expect(sentence).toBeLessThan(alphaY);
  expect(alphaY).toBeLessThan(mango);
});

test("RL-76: tapping a pending word opens its word page", async ({ page }) => {
  await openRegistro(page, ROWS());
  await rowOf(page, "zzorble").getByRole("link").click();
  await expect(page).toHaveURL(/\/registro\/zzorble$/);
});

test("RL-76: with no rows the study's empty state shows, unchanged", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await expect(page.getByText(messages.log.study.emptyTitle)).toBeVisible();
  await expect(page.getByText(WAITING)).toHaveCount(0);
});

test("RL-76: when the drain answers a pending row, the list repaints without a reload", async ({ page }) => {
  await openRegistro(page, ROWS());
  const row = rowOf(page, "zzorble");
  await expect(row.getByText(WAITING, { exact: true })).toBeVisible();

  let loads = 0;
  page.on("load", () => (loads += 1));
  // What the drain does in one transaction (M19): the pending rows go, the
  // answered row takes the same moment, then the log announces the flush.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          const store = tx.objectStore("lookups");
          store.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) {
              store.add({
                schema: 4,
                at: Date.now(),
                text: "zzorble",
                normalised: "zzorble",
                kind: "word",
                outcome: "unlisted",
                headword: "zzorble",
                rule: null,
                senses: 0,
                translation: "garabato",
                definition: "a made-up word",
                dictionaryReady: true,
                origin: null,
              });
              return;
            }
            if (cursor.value.normalised === "zzorble") cursor.delete();
            cursor.continue();
          };
          tx.oncomplete = () => {
            db.close();
            window.dispatchEvent(new Event("voyager:log-flushed"));
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

  await expect(row.getByText("garabato", { exact: true })).toBeVisible();
  await expect(row.getByText(WAITING)).toHaveCount(0);
  await expect(row.getByText(WORD_LINE)).toHaveCount(0);
  // The sentence still waits: only the answered group changed.
  await expect(rowOf(page, "the cat sits still").getByText(WAITING, { exact: true })).toBeVisible();
  expect(loads, "the page reloaded").toBe(0);
});

test("RL-76: the word page of a pending-only word says it waits and draws no answer", async ({ page }) => {
  await openRegistro(page, [pending("zzorble", NOW - 10)]);
  await page.goto("/registro/zzorble");

  await expect(page.getByRole("heading", { name: "zzorble" })).toBeVisible();
  await expect(page.getByText(PAGE_TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText(PAGE_BODY, { exact: true })).toBeVisible();
  await expect(page.getByText(SEARCHES, { exact: true })).toBeVisible();
  // The row's moment, today.
  await expect(page.getByText(/^Hoy, \d{2}:\d{2}$/)).toBeVisible();

  // No answer of any kind: not the dictionary's absence, no gloss, no audio, no ask-now button.
  await expect(page.getByText(messages.live.noEntry)).toHaveCount(0);
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Escuchar/ })).toHaveCount(0);
  await expect(page.getByText(messages.log.word.phraseMissing)).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
});

test("RL-76: the word page of an answered word keeps its answer and does not say it waits", async ({ page }) => {
  await openRegistro(page, [answered("alpha", "alfa", NOW - 10)]);
  await page.goto("/registro/alpha");
  await expect(page.getByRole("heading", { name: "alpha" })).toBeVisible();
  await expect(page.getByText(/alfa/).first()).toBeVisible();
  await expect(page.getByText(PAGE_TITLE)).toHaveCount(0);
});
