import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { createTranslator } from "next-intl";
import { expect, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";
import type { LookupRecord, SyncState } from "../lib/log/types";
import type { LogExport } from "../lib/log/export";
// A plain number, safe to import at Node runtime — `record.ts` guards every
// call that touches `indexedDB` or `window` behind a `typeof` check, and this
// constant sits outside all of them. Sourcing it here, instead of a second
// literal `2`, keeps the seeder below in lockstep with the schema it mirrors.
import { DATABASE_VERSION } from "../lib/log/record";

// The same runtime `next-intl` renders with: `log.study.header` is an ICU
// plural, so a literal `"{lookups}"` substring never appears in the
// rendered text and a naive `.replace` against it always misses.
const t = createTranslator({ locale: "es", messages });

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the word path here must never reach it.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// `useDecoration`'s own debounce (`PHRASE_DEBOUNCE_MS`) plus margin: long
// enough that its pair of requests has fired by the time this elapses.
const DECORATION_SETTLE_MARGIN_MS = 900;

// Exposes every `Worker` construction as `window.__workersBuilt`, so a test
// can prove `/registro` mounts none (RNL-08) without importing the hook that
// would create one.
async function countWorkerConstructions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __workersBuilt: number }).__workersBuilt = 0;
    const NativeWorker = window.Worker;
    class CountingWorker extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        (window as unknown as { __workersBuilt: number }).__workersBuilt += 1;
      }
    }
    window.Worker = CountingWorker as unknown as typeof Worker;
  });
}

// Raw IndexedDB, mirroring `lib/log/record.ts`'s own shape — this file runs
// inside `page.evaluate`, a browser context no Node import reaches, so it
// opens the same database by name instead of importing `readAll`.
async function readRawRows(page: Page): Promise<LookupRecord[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readonly");
          const getAll = tx.objectStore("lookups").getAll();
          getAll.onsuccess = () => resolve(getAll.result);
          getAll.onerror = () => reject(getAll.error);
        };
      }),
  );
}

// Mirrors `lib/log/record.ts`'s own `onupgradeneeded`, version pin included:
// this may race the app's mount effect for who creates `reading-log` first,
// so it stays able to build the store itself rather than assume the app
// already did. Opening at a fixed, imported version — not versionless, the
// fix that applies to a reader — is what a schema's own creator does; a
// version this call wins the race at is a version the app's own later open
// must find already there, or its `onupgradeneeded` tries to recreate the
// sync store and aborts.
async function seedRows(page: Page, count: number): Promise<void> {
  await page.evaluate(
    ({ count, version }) =>
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
          const store = tx.objectStore("lookups");
          for (let i = 0; i < count; i++) {
            store.add({
              schema: 1,
              at: Date.now() - i,
              text: `seed-${i}`,
              normalised: `seed-${i}`,
              kind: "word",
              outcome: "miss",
              headword: null,
              rule: null,
              senses: 0,
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
    { count, version: DATABASE_VERSION },
  );
}

async function downloadExport(page: Page): Promise<LogExport> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: messages.log.study.download }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^registro-lecturas-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  if (!path) throw new Error("no download path");
  const contents = await fs.readFile(path, "utf-8");
  return JSON.parse(contents) as LogExport;
}

test("10,003 rows export whole, and the file round-trips through JSON exactly", async ({ page }) => {
  // A larger workload than the suite's default 30s comfortably covers:
  // 10,003 IndexedDB writes, then a 10,003-row JSON round trip.
  test.setTimeout(60_000);
  await deleteTranslator(page);

  // `/registro` never imports `lib/dictionary`: opening it directly needs no
  // asset and never mounts a Worker (RNL-08), unlike `/`.
  await page.goto("/registro");
  await expect(page.getByRole("heading", { name: messages.log.title })).toBeVisible();

  await seedRows(page, 10_003);
  await page.reload();

  // What this waits for is a fold over 10,003 rows, and `expect`'s own default
  // is 5s while the test above budgets 60s for exactly this workload. With two
  // workers on a two-core runner the fold lands outside the 5s: measured in CI
  // 2026-09-19, `element(s) not found` with the screen already drawn and the
  // heading in place. The number below matches the work, not the patience.
  await expect(page.getByText(t("log.study.header", { lookups: 10_003, words: 10_003 }))).toBeVisible({
    timeout: 30_000,
  });

  const rawRows = await readRawRows(page);
  expect(rawRows).toHaveLength(10_003);

  const exported = await downloadExport(page);
  // The envelope stays at 1 and the row schema moves with the store: a reader
  // that only knows version 1 still parses the file (plan, decision 10).
  expect(exported.exportSchema).toBe(1);
  expect(exported.recordSchema).toBe(3);
  expect(typeof exported.exportedAt).toBe("number");
  expect(exported.rows).toHaveLength(10_003);
  expect(exported.rows).toEqual(rawRows);
});

test("the nav reaches /registro, which counts what was searched and exports it", async ({ page }) => {
  await deleteTranslator(page);

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("apple");
  // A lookup is recorded only once its answer has settled: clearing the box
  // earlier supersedes the query before it resolves, and nothing is logged.
  // Under load the answer lands tens of milliseconds after the next fill.
  await expect(page.getByRole("heading", { name: "apple" })).toBeVisible();
  await searchBox.fill("");
  await page.waitForTimeout(300);

  // Reached through the nav bar, which is the only way in since module 6
  // dropped the search screen's link to `/fuente` and module 10 moved the
  // credit to `/cuenta`. The old route through `/fuente` no longer exists.
  await page.getByRole("navigation", { name: messages.nav.label }).getByRole("link", { name: messages.nav.log }).click();
  await expect(page).toHaveURL(/\/registro$/);

  await expect(page.getByText(t("log.study.header", { lookups: 1, words: 1 }))).toBeVisible();

  const exported = await downloadExport(page);
  expect(exported.exportSchema).toBe(1);
  expect(exported.rows).toHaveLength(1);
  expect(exported.rows[0].kind).toBe("word");
  expect(exported.rows[0].text).toBe("apple");
});

test("RNL-08: /registro mounts no dictionary Worker, and searching issues no request the export path would own", async ({
  page,
}) => {
  await deleteTranslator(page);
  await countWorkerConstructions(page);

  // Reached cold, the way a reader who never opened the box would reach it.
  await page.goto("/registro");
  await expect(page.getByRole("heading", { name: messages.log.title })).toBeVisible();
  await page.waitForTimeout(300);

  const requestsOnRegistro: string[] = [];
  page.on("request", (request) => requestsOnRegistro.push(request.url()));
  await page.waitForTimeout(500);
  expect(requestsOnRegistro.some((url) => url.includes(manifest.asset.path))).toBe(false);

  const workersOnRegistro = await page.evaluate(
    () => (window as unknown as { __workersBuilt: number }).__workersBuilt,
  );
  expect(workersOnRegistro).toBe(0);

  // Now the search screen: the one Worker construction it owns, and the one
  // request its own asset fetch owns — neither repeats on a keystroke.
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  const tenKeystrokes = "throughout";

  // A warm-up run of the exact same keystrokes first, autocomplete included,
  // so every web font any state along the way paints is already cached
  // before the measured run: a font request belongs to painting a state for
  // the first time ever, not to the word path RL-14 governs. Clearing the
  // box straight after the heading aborts decoration's own debounce before
  // it fires, so the word is never cached from this run.
  await searchBox.pressSequentially(tenKeystrokes, { delay: 40 });
  await expect(page.getByRole("heading", { name: tenKeystrokes })).toBeVisible();
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const requestsWhileTyping: string[] = [];
  page.on("request", (request) => requestsWhileTyping.push(request.url()));

  await searchBox.pressSequentially(tenKeystrokes, { delay: 40 });
  await expect(page.getByRole("heading", { name: tenKeystrokes })).toBeVisible();

  // The stricter bound: at the instant of paint, decoration's own debounce
  // has not fired yet, so ten keystrokes owe nothing at all — the route
  // included.
  expect(
    requestsWhileTyping,
    `requests at paint, ten keystrokes issued: ${JSON.stringify(requestsWhileTyping)}`,
  ).toHaveLength(0);

  await page.waitForTimeout(DECORATION_SETTLE_MARGIN_MS);

  const stray = requestsWhileTyping.filter((url) => !url.includes("/api/word/"));
  expect(stray, `requests foreign to decoration: ${JSON.stringify(stray)}`).toEqual([]);

  // One settled word, never one request per keystroke.
  const decoration = requestsWhileTyping.filter((url) => url.includes("/api/word/"));
  expect(decoration.length, "decoration never asked").toBeGreaterThanOrEqual(1);
  expect(decoration.length).toBeLessThanOrEqual(2);
});


// ---------------------------------------------------------------------------
// RL-65, RNL-08: the Anki CSV beside the JSON (boards RegistroExportarAnki,
// RegistroExportarAnkiEstados). Written from the board and the contract, not
// from the component.
// ---------------------------------------------------------------------------

type SeedLookup = Omit<LookupRecord, "id">;

const study = messages.log.study;
const jsonControl = (page: Page) => page.getByRole("button", { name: study.download, exact: true });
const ankiControl = (page: Page) => page.getByRole("button", { name: study.downloadAnki, exact: true });

function studyRow(word: string, translation: string | null, at: number, extra: Partial<SeedLookup> = {}): SeedLookup {
  return {
    schema: 3,
    at,
    text: word,
    normalised: word,
    kind: "word",
    outcome: translation === null ? "miss" : "exact",
    headword: translation === null ? null : word,
    rule: null,
    senses: translation === null ? 0 : 1,
    translation,
    dictionaryReady: true,
    origin: "device",
    ...extra,
  };
}

// Study order is count desc, then most recent first: alpha (2 searches), then
// zebra (newer), then mango. "quiet" has no translation and owes no card.
const NOW = Date.now();
const STUDY_ROWS: SeedLookup[] = [
  studyRow("alpha", 'alfa, "primera"', NOW - 50),
  studyRow("alpha", 'alfa, "primera"', NOW - 40),
  studyRow("mango", "mango", NOW - 30),
  studyRow("zebra", "cebra", NOW - 20),
  studyRow("quiet", null, NOW - 10),
];
const EXPECTED_CARDS = ['"alpha","alfa, ""primera"""', '"zebra","cebra"', '"mango","mango"'];

function copyOn(): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
  };
}

// Seeds from the home screen: /registro reads the sync row on open and would
// race this write (same reason as registro-copia.spec.ts).
async function seedStudy(page: Page, rows: SeedLookup[], sync: SyncState | null = null): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  await page.evaluate(
    ({ version, sync, lookups }) =>
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
          const tx = db.transaction(["lookups", "sync"], "readwrite");
          if (sync) tx.objectStore("sync").put({ ...sync, key: "state" });
          for (const lookup of lookups) tx.objectStore("lookups").add(lookup);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, sync, lookups: rows },
  );
}

async function openSeeded(page: Page): Promise<void> {
  await deleteTranslator(page);
  await seedStudy(page, STUDY_ROWS);
  await page.goto("/registro");
  await expect(jsonControl(page)).toBeVisible();
}

async function downloadAnki(page: Page): Promise<{ name: string; text: string }> {
  const downloadPromise = page.waitForEvent("download");
  await ankiControl(page).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("no download path");
  return { name: download.suggestedFilename(), text: await fs.readFile(path, "utf-8") };
}

test("RL-65: with rows, the JSON and the Anki controls both show, by exact name", async ({ page }) => {
  await openSeeded(page);
  await expect(jsonControl(page)).toBeVisible();
  await expect(ankiControl(page)).toBeVisible();
  // The Anki control sits under the JSON one, same column.
  const json = await jsonControl(page).boundingBox();
  const anki = await ankiControl(page).boundingBox();
  expect(anki!.y).toBeGreaterThan(json!.y);
  expect(anki!.height).toBeGreaterThanOrEqual(44);
});

test("RL-65: the Anki download is registro-lecturas-<date>-anki.csv, one card per translated group in study order, and the done line counts them", async ({
  page,
}) => {
  await openSeeded(page);
  const file = await downloadAnki(page);
  expect(file.name).toMatch(/^registro-lecturas-\d{4}-\d{2}-\d{2}-anki\.csv$/);
  const lines = file.text.split("\n");
  expect(lines.slice(0, 2)).toEqual(["#separator:Comma", "#html:false"]);
  expect(lines.slice(2).filter((line) => line !== "")).toEqual(EXPECTED_CARDS);
  expect(file.text.endsWith("\n")).toBe(true);
  await expect(page.getByText(t("log.study.ankiDone", { cards: EXPECTED_CARDS.length }))).toBeVisible();
  // The JSON control is still there beside the line.
  await expect(jsonControl(page)).toBeVisible();
});

test("RL-65: the CSV declares text/csv;charset=utf-8", async ({ page }) => {
  await openSeeded(page);
  // The blob's type is read from the object URL the anchor points at, before
  // the page revokes it.
  await page.evaluate(() => {
    const w = window as unknown as { __blobTypes: string[] };
    w.__blobTypes = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof Blob) w.__blobTypes.push(object.type);
      return create(object);
    };
  });
  await downloadAnki(page);
  const types = await page.evaluate(() => (window as unknown as { __blobTypes: string[] }).__blobTypes);
  expect(types).toEqual(["text/csv;charset=utf-8"]);
});

test("RL-65: while the cards are read, the Anki control reads «Preparando las tarjetas…» and is disabled; the JSON control is untouched", async ({
  page,
}) => {
  await openSeeded(page);
  // A readwrite transaction on `lookups` kept alive by chained reads: the
  // study's readonly transaction queues behind it until it is released.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const w = window as unknown as { __hold: boolean };
        w.__hold = true;
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("lookups", "readwrite");
          const store = tx.objectStore("lookups");
          let first = true;
          const step = () => {
            const get = store.get(1);
            get.onsuccess = () => {
              if (first) {
                first = false;
                resolve();
              }
              if (w.__hold) step();
            };
          };
          step();
        };
      }),
  );
  const downloadPromise = page.waitForEvent("download");
  await ankiControl(page).click();
  const preparing = page.getByRole("button", { name: study.ankiPreparing, exact: true });
  await expect(preparing).toBeVisible();
  await expect(preparing).toBeDisabled();
  await expect(ankiControl(page)).toHaveCount(0);
  await expect(jsonControl(page)).toBeEnabled();
  await expect(page.getByText(study.ankiFailed)).toHaveCount(0);

  await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = false));
  await downloadPromise;
  await expect(page.getByText(t("log.study.ankiDone", { cards: EXPECTED_CARDS.length }))).toBeVisible();
  await expect(ankiControl(page)).toBeEnabled();
});

test("RL-65: a failed read shows «No se pudo preparar el archivo para Anki» and «Reintentar», and the retry reads again and succeeds", async ({
  page,
}) => {
  await openSeeded(page);
  let downloads = 0;
  page.on("download", () => (downloads += 1));
  // The page opens transactions of its own after load (the history list, the
  // sync pull, the counts); under load one of them reaches the hook before the
  // click and spends a hook armed up front. The hook arms on the click itself
  // and fails the first read of `lookups` after it, which is the study's.
  await page.evaluate(() => {
    const w = window as unknown as { __thrown: number; __failNext: boolean };
    w.__thrown = 0;
    w.__failNext = false;
    document.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("button")) w.__failNext = true;
      },
      { capture: true, once: true },
    );
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
      const [scope, mode] = args;
      if (w.__failNext && mode !== "readwrite" && scope === "lookups") {
        w.__failNext = false;
        w.__thrown += 1;
        throw new DOMException("e2e: read refused", "InvalidStateError");
      }
      return original.apply(this, args);
    };
  });
  await ankiControl(page).click();
  await expect(page.getByText(study.ankiFailed, { exact: true })).toBeVisible();
  const retry = page.getByRole("button", { name: messages.log.retry, exact: true });
  await expect(retry).toBeVisible();
  await expect(jsonControl(page)).toBeVisible();
  await expect(ankiControl(page)).toBeVisible();
  expect(downloads, "a failed read offered a file").toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __thrown: number }).__thrown)).toBe(1);

  const downloadPromise = page.waitForEvent("download");
  await retry.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-anki\.csv$/);
  await expect(page.getByText(t("log.study.ankiDone", { cards: EXPECTED_CARDS.length }))).toBeVisible();
  await expect(page.getByText(study.ankiFailed)).toHaveCount(0);
  await expect(retry).toHaveCount(0);
});

test("RL-65: a confirmed zero shows neither control, and clearing the log takes both away without a reload", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await expect(page.getByText(study.emptyTitle)).toBeVisible();
  await expect(jsonControl(page)).toHaveCount(0);
  await expect(ankiControl(page)).toHaveCount(0);

  await seedStudy(page, STUDY_ROWS);
  await page.goto("/registro");
  await expect(ankiControl(page)).toBeVisible();
  await expect(jsonControl(page)).toBeVisible();
  await page.getByRole("button", { name: messages.log.clear.trigger }).click();
  await page.getByRole("button", { name: messages.log.clear.soleAction }).click();
  await expect(page.getByText(study.emptyTitle)).toBeVisible();
  await expect(jsonControl(page)).toHaveCount(0);
  await expect(ankiControl(page)).toHaveCount(0);
});

// `deleteStudyGroup` lives in a module the production page does not expose,
// and the row's ✕ is K10's. This test therefore does what that function does
// to the store (removes the group's rows in one transaction) and fires the
// event it announces itself with, `voyager:log-deleted`.
test("RL-66: after the last group is deleted, both controls leave without a reload", async ({ page }) => {
  await deleteTranslator(page);
  await seedStudy(page, [studyRow("alpha", "alfa", NOW)]);
  await page.goto("/registro");
  await expect(ankiControl(page)).toBeVisible();
  await expect(jsonControl(page)).toBeVisible();

  let loads = 0;
  page.on("load", () => (loads += 1));
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          tx.objectStore("lookups").clear();
          tx.oncomplete = () => {
            db.close();
            window.dispatchEvent(new Event("voyager:log-deleted"));
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await expect(jsonControl(page)).toHaveCount(0);
  await expect(ankiControl(page)).toHaveCount(0);
  expect(loads, "the page reloaded").toBe(0);
});

function answerJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("RL-65: rows a sync round lands show both controls without a reload", async ({ page }) => {
  await deleteTranslator(page);
  await seedStudy(page, [], copyOn());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, {
      accepted: 0,
      rows: [
        {
          deviceId: randomUUID(),
          localId: 1,
          at: Date.now(),
          text: "zebra",
          normalised: "zebra",
          kind: "word",
          outcome: "exact",
          headword: "zebra",
          rule: null,
          senses: 1,
          translation: "cebra",
          dictionaryReady: true,
          origin: "device",
          recordSchema: 2,
          definition: null,
          exampleEn: null,
          exampleEs: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: "zebra-cursor",
    });
  });
  let loads = 0;
  page.on("load", () => (loads += 1));

  await page.goto("/registro");
  await expect(page.getByText(study.emptyTitle)).toBeVisible();
  await expect(jsonControl(page)).toHaveCount(0);
  await expect(ankiControl(page)).toHaveCount(0);
  const loadsBefore = loads;

  release();
  await expect(jsonControl(page)).toBeVisible();
  await expect(ankiControl(page)).toBeVisible();
  expect(loads).toBe(loadsBefore);

  const file = await downloadAnki(page);
  expect(file.text.split("\n").slice(2).filter((line) => line !== "")).toEqual(['"zebra","cebra"']);
});

test("RNL-08: building the Anki CSV mounts no dictionary Worker and fetches no dictionary asset", async ({ page }) => {
  await countWorkerConstructions(page);
  await openSeeded(page);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await downloadAnki(page);
  await expect(page.getByText(t("log.study.ankiDone", { cards: EXPECTED_CARDS.length }))).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __workersBuilt: number }).__workersBuilt)).toBe(0);
  expect(requests.some((url) => url.includes(manifest.asset.path))).toBe(false);
});

// ---------------------------------------------------------------------------
// RL-72: the Anki link hides when no row gives a card and says what stays out
// (board RegistroExportarAnkiSinTarjeta).
// ---------------------------------------------------------------------------

function unlistedRow(word: string, definition: string | null, at: number): SeedLookup {
  return studyRow(word, null, at, { outcome: "unlisted", kind: "word", definition });
}

async function openRows(page: Page, rows: SeedLookup[]): Promise<void> {
  await deleteTranslator(page);
  await seedStudy(page, rows);
  await page.goto("/registro");
  await expect(jsonControl(page)).toBeVisible();
}

test("RL-72: a record with no card offers no Anki file and says why, the JSON link stays", async ({ page }) => {
  await openRows(page, [unlistedRow("blorp", null, NOW - 20), unlistedRow("flarn", null, NOW - 10)]);
  await expect(page.getByText(t("log.study.ankiNone", { words: 2 }), { exact: true })).toBeVisible();
  await expect(ankiControl(page)).toHaveCount(0);
  await expect(jsonControl(page)).toBeVisible();
});

test("RL-72: one word with no card says «tu palabra…»", async ({ page }) => {
  await openRows(page, [unlistedRow("blorp", null, NOW)]);
  await expect(page.getByText(t("log.study.ankiNone", { words: 1 }), { exact: true })).toBeVisible();
  await expect(ankiControl(page)).toHaveCount(0);
});

test("RL-72: a network word with a definition gives a card whose back is the definition", async ({ page }) => {
  await openRows(page, [unlistedRow("blorp", "a made-up word", NOW)]);
  await expect(ankiControl(page)).toBeVisible();
  await expect(page.getByText(/^Para Anki:/)).toHaveCount(0);
  const file = await downloadAnki(page);
  expect(file.text.split("\n").slice(2).filter((line) => line !== "")).toEqual(['"blorp","a made-up word"']);
});

test("RL-72: after a download, the words left out are named under the done line", async ({ page }) => {
  await openSeeded(page);
  await downloadAnki(page);
  const done = page.getByText(t("log.study.ankiDone", { cards: 3 }), { exact: true });
  const skipped = page.getByText(t("log.study.ankiSkipped", { count: 1 }), { exact: true });
  await expect(done).toBeVisible();
  await expect(skipped).toBeVisible();
  expect((await skipped.boundingBox())!.y).toBeGreaterThan((await done.boundingBox())!.y);
});

test("RL-72: when every word gives a card, no left-out line shows", async ({ page }) => {
  await openRows(page, [studyRow("alpha", "alfa", NOW - 20), studyRow("zebra", "cebra", NOW - 10)]);
  await downloadAnki(page);
  await expect(page.getByText(t("log.study.ankiDone", { cards: 2 }), { exact: true })).toBeVisible();
  await expect(page.getByText(/palabras? no van?:/)).toHaveCount(0);
});

test("RL-72: deleting the only card's row leaves the no-card line, without a reload", async ({ page }) => {
  await openRows(page, [studyRow("alpha", "alfa", NOW - 20), unlistedRow("blorp", null, NOW - 10)]);
  await expect(ankiControl(page)).toBeVisible();
  let loads = 0;
  page.on("load", () => (loads += 1));
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
            if (!cursor) return;
            if (cursor.value.text === "alpha") cursor.delete();
            cursor.continue();
          };
          tx.oncomplete = () => {
            db.close();
            window.dispatchEvent(new Event("voyager:log-deleted"));
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await expect(page.getByText(t("log.study.ankiNone", { words: 1 }), { exact: true })).toBeVisible();
  await expect(ankiControl(page)).toHaveCount(0);
  await expect(jsonControl(page)).toBeVisible();
  expect(loads, "the page reloaded").toBe(0);
});

test("RL-72: a sync round that lands a translated row on a no-card record brings the link, without a reload", async ({
  page,
}) => {
  await deleteTranslator(page);
  await seedStudy(page, [unlistedRow("blorp", null, NOW)], copyOn());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, {
      accepted: 0,
      rows: [
        {
          deviceId: randomUUID(),
          localId: 1,
          at: Date.now(),
          text: "zebra",
          normalised: "zebra",
          kind: "word",
          outcome: "exact",
          headword: "zebra",
          rule: null,
          senses: 1,
          translation: "cebra",
          dictionaryReady: true,
          origin: "device",
          recordSchema: 2,
          definition: null,
          exampleEn: null,
          exampleEs: null,
          receivedAt: new Date().toISOString(),
        },
      ],
      cursor: "zebra-cursor",
    });
  });
  let loads = 0;
  page.on("load", () => (loads += 1));

  await page.goto("/registro");
  await expect(page.getByText(t("log.study.ankiNone", { words: 1 }), { exact: true })).toBeVisible();
  await expect(ankiControl(page)).toHaveCount(0);
  const loadsBefore = loads;

  release();
  await expect(ankiControl(page)).toBeVisible();
  await expect(page.getByText(t("log.study.ankiNone", { words: 1 }), { exact: true })).toHaveCount(0);
  expect(loads).toBe(loadsBefore);
});

test("while the JSON is built, its control reads «Exportando…» and is disabled; the Anki control is untouched", async ({
  page,
}) => {
  await openSeeded(page);
  // A readwrite transaction on `lookups` kept alive by chained reads: the
  // export's readonly transaction queues behind it until it is released.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const w = window as unknown as { __hold: boolean };
        w.__hold = true;
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("lookups", "readwrite");
          const store = tx.objectStore("lookups");
          let first = true;
          const step = () => {
            const get = store.get(1);
            get.onsuccess = () => {
              if (first) {
                first = false;
                resolve();
              }
              if (w.__hold) step();
            };
          };
          step();
        };
      }),
  );
  const downloadPromise = page.waitForEvent("download");
  await jsonControl(page).click();
  const building = page.getByRole("button", { name: messages.log.exporting, exact: true });
  await expect(building).toBeVisible();
  await expect(building).toBeDisabled();
  await expect(jsonControl(page)).toHaveCount(0);
  await expect(ankiControl(page)).toBeEnabled();

  await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = false));
  await downloadPromise;
  await expect(jsonControl(page)).toBeEnabled();
});
