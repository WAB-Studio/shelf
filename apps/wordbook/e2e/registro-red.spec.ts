import { randomUUID } from "node:crypto";

import { expect, STUB_HEADER, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";
import manifest from "../public/dictionary/manifest.json";

// RL-55: a word the dictionary has no entry for is recorded when, and only
// when, the network's answer (RL-44) arrived for that same text.

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function openReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);
}

type Row = {
  text: string;
  normalised: string;
  kind: string;
  outcome: string;
  headword: string | null;
  senses: number;
  translation: string | null;
  origin: unknown;
};

// The dictionary's own store holds a manifest once the install has landed.
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
        const count = db.transaction("meta", "readonly").objectStore("meta").count();
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

async function readLogRows(page: Page): Promise<Row[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("lookups", "readonly");
          const getAll = tx.objectStore("lookups").getAll();
          getAll.onsuccess = () => resolve(getAll.result);
          getAll.onerror = () => reject(getAll.error);
        };
      }),
  );
}

const BODY = {
  translations: ["¿en dónde?", "adónde"],
  definition: "At what place.",
  example: { en: "Whereat did he look?", es: "¿Hacia dónde miró?" },
  lemma: null,
  rule: null,
};

// Settling is the reader moving on: the box is cleared, as log.spec.ts does.
async function settle(page: Page, box: ReturnType<Page["getByRole"]>): Promise<void> {
  await box.fill("");
  await page.waitForTimeout(400);
}

function isUnlistedPost(url: string): boolean {
  return new URL(url).pathname === "/api/word/unlisted";
}

test("respondida: whereat with a 200 answer leaves one unlisted row carrying the body's translation", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("whereat");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 2000 });
  await settle(page, box);

  const rows = (await readLogRows(page)).filter((row) => row.normalised === "whereat");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "word",
    outcome: "unlisted",
    headword: "whereat",
    senses: 0,
    translation: "¿en dónde?, adónde",
    origin: null,
  });
});

test("fallida: whereat answered 204 leaves no row", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  const answered = page.waitForResponse((r) => isUnlistedPost(r.url()));
  await box.fill("whereat");
  expect((await answered).status()).toBe(204);
  await page.waitForTimeout(300);
  await settle(page, box);

  expect((await readLogRows(page)).filter((row) => row.normalised === "whereat")).toHaveLength(0);
});

test("pendiente: an answer held while the reader clears the box leaves no row, even once it arrives", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let requested = false;
  await page.route(
    (url) => isUnlistedPost(url.toString()),
    async (route) => {
      requested = true;
      await gate;
      await route.fallback();
    },
  );
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("whereat");
  await expect.poll(() => requested, { timeout: 3000 }).toBe(true);
  await settle(page, box);
  expect((await readLogRows(page)).filter((row) => row.normalised === "whereat")).toHaveLength(0);

  release();
  await page.waitForTimeout(1500);
  expect((await readLogRows(page)).filter((row) => row.normalised === "whereat")).toHaveLength(0);
});

test("forma con lema: ran, even with a network lemma, stays inflected and writes no unlisted row", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted({ ...BODY, translations: ["corrió"], lemma: "run", rule: "irregular" });
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("ran");
  await page.waitForTimeout(1500);
  await settle(page, box);

  const rows = (await readLogRows(page)).filter((row) => row.normalised === "ran");
  expect(rows).toHaveLength(1);
  expect(rows[0].outcome).toBe("inflected");
  expect(rows[0].headword).toBe("run");
});

test("caché de la pestaña: a second visit to whereat after another word leaves a second row", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  for (const word of ["whereat", "coccidiosis", "whereat"]) {
    await box.fill(word);
    await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 2000 });
    await settle(page, box);
  }

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.normalised === "whereat" && row.outcome === "unlisted")).toHaveLength(2);
  expect(rows.filter((row) => row.normalised === "coccidiosis" && row.outcome === "unlisted")).toHaveLength(1);
});

test("corte: translations joined past 120 characters are stored cut, never longer", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  const long = Array.from({ length: 12 }, (_, i) => `traduccion${i}xx`);
  const joined = long.join(", ");
  expect(joined.length).toBeGreaterThan(120);
  await stubUnlisted({ ...BODY, translations: long });
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("whereat");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 2000 });
  await settle(page, box);

  const rows = (await readLogRows(page)).filter((row) => row.normalised === "whereat");
  expect(rows).toHaveLength(1);
  const stored = rows[0].translation as string;
  expect(stored.length).toBeLessThanOrEqual(120);
  expect(stored.length).toBeGreaterThan(100);
  expect(joined.startsWith(stored)).toBe(true);
  expect(stored).not.toMatch(/[,\s]$/u);
});

test("bajo su búsqueda: an answer for coccidiosis that arrives after the box moved to another word leaves no unlisted row", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  // The first request (coccidiosis) is held; any later one is refused with a
  // 204, so a row under the second word could only come from the held answer.
  await page.route(
    (url) => isUnlistedPost(url.toString()),
    async (route) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        await route.fallback();
      } else {
        await route.fulfill({ status: 204, headers: { [STUB_HEADER]: "1" } });
      }
    },
  );
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("coccidiosis");
  await expect.poll(() => calls, { timeout: 10000 }).toBe(1);
  await box.fill("whereat");
  await expect.poll(() => calls, { timeout: 10000 }).toBe(2);
  await page.waitForTimeout(400);

  release();
  await page.waitForTimeout(1500);
  await settle(page, box);

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.outcome === "unlisted")).toHaveLength(0);
});

test("una vez: a focus change and a colour-scheme change after the answer was recorded leave one row", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("whereat");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 10000 });

  await box.blur();
  await box.focus();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(500);
  await settle(page, box);

  const rows = (await readLogRows(page)).filter((row) => row.normalised === "whereat");
  expect(rows).toHaveLength(1);
  expect(rows[0].outcome).toBe("unlisted");
});

test("bajo su búsqueda: returning to a word whose answer the tab holds records each row under the text it was typed, headword included", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  for (const word of ["whereat", "coccidiosis", "whereat"]) {
    await box.fill(word);
    await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 10000 });
    await settle(page, box);
  }

  const unlisted = (await readLogRows(page)).filter((row) => row.outcome === "unlisted");
  expect(unlisted.map((row) => row.text)).toEqual(["whereat", "coccidiosis", "whereat"]);
  for (const row of unlisted) expect(row.headword).toBe(row.normalised);
});


// ---- Module 700 · RL-62, RL-61: the whole answer is kept and read back ----
// A word the network answered keeps its translation, definition and example on
// the row; its /registro page paints them as the resolved network block, with
// or without a connection, and asks the network for nothing.

type Seed = Omit<LookupRecord, "id">;

const DOOM = {
  translation: "deslizar sin parar por malas noticias",
  definition: "Compulsively scrolling through bad news.",
  exampleEn: "He lost an hour doomscrolling before bed.",
  exampleEs: "Perdió una hora deslizando antes de dormir.",
};

function unlistedSeed(over: Partial<Seed> = {}): Seed {
  return {
    schema: 3,
    at: Date.now(),
    text: "doomscrolling",
    normalised: "doomscrolling",
    kind: "word",
    outcome: "unlisted",
    headword: "doomscrolling",
    rule: null,
    senses: 0,
    translation: DOOM.translation,
    definition: DOOM.definition,
    exampleEn: DOOM.exampleEn,
    exampleEs: DOOM.exampleEs,
    dictionaryReady: true,
    origin: null,
    ...over,
  };
}

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

// Seeds from the home screen, once the dictionary is installed: /registro
// itself mints the sync row and would race the write.
async function seedFromHome(
  page: Page,
  rows: { sync?: SyncState; lookups?: Seed[] },
  installs = true,
): Promise<void> {
  if (installs) {
    await openReady(page);
  } else {
    await page.goto("/");
    await page.waitForTimeout(1000);
  }
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
          for (const row of lookups ?? []) tx.objectStore("lookups").add(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, sync: rows.sync ?? null, lookups: rows.lookups ?? [] },
  );
}

async function expectWholeAnswer(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "doomscrolling", exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.translation, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.word.definitionEnglish, { exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.definition, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.word.example, { exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.exampleEn, { exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.exampleEs, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
}

test("700 hecho, con red: searching doomscrolling leaves a row carrying translation, definition and both examples", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted({
    translations: [DOOM.translation],
    definition: DOOM.definition,
    example: { en: DOOM.exampleEn, es: DOOM.exampleEs },
    lemma: null,
    rule: null,
  });
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("doomscrolling");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 3000 });
  await settle(page, box);

  const rows = (await readLogRows(page)).filter((row) => row.normalised === "doomscrolling");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outcome: "unlisted",
    translation: DOOM.translation,
    definition: DOOM.definition,
    exampleEn: DOOM.exampleEn,
    exampleEs: DOOM.exampleEs,
  });
});

test("700 hecho, sin red: offline, /registro/doomscrolling paints translation, definition, example and its translation", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.route(/[?&]_rsc=/, (route) => route.abort());
  await seedFromHome(page, { lookups: [unlistedSeed()] });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect.poll(() => dictionaryInstalled(page)).toBe(true);

  await page.context().setOffline(true);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  });
  await page.goto("/registro/doomscrolling");

  expect(page.url()).not.toContain("chrome-error:");
  await expectWholeAnswer(page);
});

test("700 sin conexión pedida: opening the page paints the answer and sends no request to /api/word/*", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  // A stub that would answer, so a request for it could only come from the page.
  await stubUnlisted({
    translations: ["otra cosa"],
    definition: "Another.",
    example: { en: "Other.", es: "Otra." },
    lemma: null,
    rule: null,
  });
  await seedFromHome(page, { lookups: [unlistedSeed()] });

  const wordRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/word/")) wordRequests.push(request.url());
  });
  await page.goto("/registro/doomscrolling");
  await expectWholeAnswer(page);
  // Past use-network-answer's own debounce, so a late ask would be in by now.
  await page.waitForTimeout(1500);

  expect(wordRequests).toEqual([]);
});

test("700 fila vieja: a schema 2 row paints its translation alone, with no definition label and no example", async ({
  page,
}) => {
  await deleteTranslator(page);
  const old = unlistedSeed({ schema: 2 });
  delete old.definition;
  delete old.exampleEn;
  delete old.exampleEs;
  await seedFromHome(page, { lookups: [old] });

  await page.goto("/registro/doomscrolling");
  await expect(page.getByText(DOOM.translation, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.word.definitionEnglish, { exact: true })).toHaveCount(0);
  await expect(page.getByText(messages.word.example, { exact: true })).toHaveCount(0);
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
});

test("700 sin definición: an answer with definition null paints the example and no definition label", async ({
  page,
}) => {
  await deleteTranslator(page);
  await seedFromHome(page, { lookups: [unlistedSeed({ definition: null })] });

  await page.goto("/registro/doomscrolling");
  await expect(page.getByText(DOOM.translation, { exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.exampleEn, { exact: true })).toBeVisible();
  await expect(page.getByText(DOOM.exampleEs, { exact: true })).toBeVisible();
  await expect(page.getByText(messages.word.definitionEnglish, { exact: true })).toHaveCount(0);
});

test("700 pendiente: before the row is read the page never says the dictionary lacks the word", async ({
  page,
}) => {
  await deleteTranslator(page);
  await seedFromHome(page, { lookups: [unlistedSeed()] });

  const forbidden = [messages.search.notFound, messages.search.notFoundHint, messages.log.word.emptyBody.replace("{word}", "doomscrolling")];
  await page.addInitScript((needles) => {
    const w = window as unknown as { __saidMissing: string[] };
    w.__saidMissing = [];
    const check = () => {
      const text = document.body?.innerText ?? "";
      for (const needle of needles) if (text.includes(needle)) w.__saidMissing.push(needle);
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  }, forbidden);

  await page.goto("/registro/doomscrolling");
  await expectWholeAnswer(page);
  expect(await page.evaluate(() => (window as unknown as { __saidMissing: string[] }).__saidMissing)).toEqual([]);
});

test("700 copia: a row with the three fields pulled through /api/log/sync paints the same page", async ({ page }) => {
  await deleteTranslator(page);
  await seedFromHome(page, { sync: copyOn() });
  await page.route("**/api/log/sync", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: 0,
        rows: [
          {
            deviceId: randomUUID(),
            localId: 1,
            at: Date.now(),
            text: "doomscrolling",
            normalised: "doomscrolling",
            kind: "word",
            outcome: "unlisted",
            headword: "doomscrolling",
            rule: null,
            senses: 0,
            translation: DOOM.translation,
            dictionaryReady: true,
            origin: null,
            recordSchema: 3,
            definition: DOOM.definition,
            exampleEn: DOOM.exampleEn,
            exampleEs: DOOM.exampleEs,
            receivedAt: new Date().toISOString(),
          },
        ],
        cursor: "doom-cursor",
      }),
    }),
  );

  await page.goto("/registro");
  await expect(page.locator('a[href="/registro/doomscrolling"]')).toBeVisible();
  await page.goto("/registro/doomscrolling");
  await expectWholeAnswer(page);
});

test("700 instalación fallida: la fila con respuesta se pinta", async ({ page }) => {
  await deleteTranslator(page);
  await page.route(`**${manifest.asset.path}*`, (route) => route.abort());
  await seedFromHome(page, { lookups: [unlistedSeed()] }, false);

  await page.goto("/registro/doomscrolling");
  await expectWholeAnswer(page);
  await expect(page.getByText(messages.install.failed, { exact: true })).toHaveCount(0);
});
