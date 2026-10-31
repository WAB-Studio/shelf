import { randomUUID } from "node:crypto";

import { createTranslator } from "next-intl";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION, LOG_FLUSHED_EVENT } from "../lib/log/record";
import { LOG_DELETED_EVENT } from "../lib/log/delete";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { expect, studyHeader, test } from "./fixtures";

// RL-66, RL-56: the /registro row list around a delete. Written from the
// contract (a delete that finds nothing returns the row to idle; a late read
// never paints over a newer one; a deleted word searched again opens idle; a
// flush during a read is not lost), not from the component. Every race is built
// with a held `readwrite` transaction on `lookups` and the exported event names.

const t = createTranslator({ locale: "es", messages });
const study = (key: string, values?: Record<string, string | number>) =>
  t(`log.study.${key}` as never, values as never) as string;

type SeedLookup = Omit<LookupRecord, "id">;

let clock = 1_800_000_000_000;
function lookup(text: string, over: Partial<SeedLookup> = {}): SeedLookup {
  clock += 1000;
  return {
    schema: 3,
    at: clock,
    text,
    normalised: text,
    kind: "word",
    outcome: "exact",
    headword: text,
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: null,
    ...over,
  };
}

// leave (2 searches), leaf (1), left (1): 4 searches, 3 words.
function leaveRows(): SeedLookup[] {
  return [
    lookup("leave"),
    lookup("left", { headword: "leave", outcome: "inflected", rule: "past" }),
    lookup("leave", { headword: "leaf", outcome: "inflected", rule: "plural" }),
    lookup("left"),
  ];
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

// Seeds from "/": /registro reads `sync` on mount and would race this write.
async function seed(page: Page, lookups: SeedLookup[]): Promise<void> {
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
          tx.objectStore("sync").put({ ...sync, key: "state" });
          for (const row of lookups) tx.objectStore("lookups").add(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { version: DATABASE_VERSION, sync: copyOn(), lookups },
  );
}

async function openRegistro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  await seed(page, leaveRows());
  await page.goto("/registro");
  await expect(rowLink(page, "leave")).toBeVisible();
}

// Adds rows behind the page. Resolves when the transaction commits, so a caller
// holding the store open must not await it before releasing.
function addRows(page: Page, rows: SeedLookup[]): Promise<void> {
  return page.evaluate(
    (rows) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          for (const row of rows) tx.objectStore("lookups").add(row);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    rows,
  );
}

// Starts an add and returns at once; `finishAdd` awaits its commit.
async function startAdd(page: Page, rows: SeedLookup[]): Promise<void> {
  await page.evaluate((rows) => {
    const w = window as unknown as { __added: Promise<void> };
    w.__added = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("reading-log");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("lookups", "readwrite");
        for (const row of rows) tx.objectStore("lookups").add(row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, rows);
}
const finishAdd = (page: Page) =>
  page.evaluate(() => (window as unknown as { __added: Promise<void> }).__added);

// Removes a group's rows behind the page; no event is fired.
function removeGroup(page: Page, key: string): Promise<void> {
  return page.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          const store = tx.objectStore("lookups");
          const all = store.getAll();
          all.onsuccess = () => {
            for (const row of all.result) if ((row.headword ?? row.normalised) === key) store.delete(row.id);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    key,
  );
}

// A readwrite transaction on `lookups` kept alive until `release`: every read
// and write opened after it waits.
async function hold(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const w = window as unknown as { __release: boolean };
        w.__release = false;
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const store = request.result.transaction("lookups", "readwrite").objectStore("lookups");
          const pump = () => {
            if (!w.__release) store.get(1).onsuccess = pump;
          };
          pump();
          resolve();
        };
      }),
  );
}
const release = (page: Page) =>
  page.evaluate(() => ((window as unknown as { __release: boolean }).__release = true));

const fire = (page: Page, name: string) => page.evaluate((n) => window.dispatchEvent(new Event(n)), name);

const rowLink = (page: Page, word: string) => page.locator(`a[href="/registro/${word}"]`);
const deleteX = (page: Page, word: string) =>
  page.getByRole("button", { name: study("deleteRow", { word }), exact: true });
const action = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).or(page.getByRole("link", { name, exact: true }));
const header = (page: Page, lookups: number, words: number) => studyHeader(page, lookups, words);
const deleting = (page: Page) => page.getByText(study("deleting"), { exact: true });

async function deleteViaUi(page: Page, word: string): Promise<void> {
  await deleteX(page, word).click();
  await action(page, study("deleteConfirm")).click();
}

test("A delete that finds nothing returns the row to idle: no «Borrando…», its ✕ back and enabled", async ({ page }) => {
  await openRegistro(page);
  await expect(header(page, 4, 3)).toBeVisible();
  // The group is gone behind the page and no event reaches it, so the delete is
  // the only thing that can settle the row.
  await removeGroup(page, "leave");
  await page.evaluate((name) => {
    const original = window.dispatchEvent.bind(window);
    window.dispatchEvent = (event: Event) => (event.type === name ? true : original(event));
  }, LOG_DELETED_EVENT);

  await deleteViaUi(page, "leave");

  await expect(deleteX(page, "leave")).toBeVisible();
  await expect(deleteX(page, "leave")).toBeEnabled();
  await expect(deleting(page)).toHaveCount(0);
});

test("A slow read never overwrites a newer one: a delete under a held read ends with the post-delete rows and header", async ({
  page,
}) => {
  await openRegistro(page);
  await expect(header(page, 4, 3)).toBeVisible();

  await hold(page);
  await fire(page, LOG_FLUSHED_EVENT); // a reread starts and waits behind the hold
  await deleteX(page, "leave").click();
  await action(page, study("deleteConfirm")).click();
  await expect(deleting(page)).toBeVisible();
  await release(page);

  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(header(page, 2, 2)).toBeVisible();
  await expect(deleting(page)).toHaveCount(0);
  await expect(rowLink(page, "leaf")).toBeVisible();
  await expect(rowLink(page, "left")).toBeVisible();
});

test("A deleted word searched again opens idle: its ✕ shows and «Borrando…» does not", async ({ page }) => {
  await openRegistro(page);
  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(header(page, 2, 2)).toBeVisible();

  await addRows(page, [lookup("leave")]);
  await fire(page, LOG_FLUSHED_EVENT);

  await expect(rowLink(page, "leave")).toBeVisible();
  await expect(deleteX(page, "leave")).toBeVisible();
  await expect(deleting(page)).toHaveCount(0);
});

test("A flush during a read is not lost: the row recorded under the held read appears without a reload", async ({
  page,
}) => {
  await openRegistro(page);
  await expect(header(page, 4, 3)).toBeVisible();

  await hold(page);
  await fire(page, LOG_FLUSHED_EVENT); // the read starts and waits behind the hold
  await startAdd(page, [lookup("zebra")]);
  await fire(page, LOG_FLUSHED_EVENT); // lands while that read is still open
  await expect(rowLink(page, "zebra")).toHaveCount(0);
  await release(page);
  await finishAdd(page);

  await expect(rowLink(page, "zebra")).toBeVisible();
  await expect(header(page, 5, 4)).toBeVisible();
});
