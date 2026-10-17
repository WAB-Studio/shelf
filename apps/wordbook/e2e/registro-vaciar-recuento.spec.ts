import { randomUUID } from "node:crypto";
import path from "node:path";

import { createTranslator } from "next-intl";
import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION, LOG_FLUSHED_EVENT } from "../lib/log/record";
import { LOG_DELETED_EVENT } from "../lib/log/delete";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { expect, test } from "./fixtures";

// RL-55 («empty it whole»): «Vaciar el registro» states the record as it is
// now, after every delete, flush or pull, without a reload. Written from the
// contract of B1 and the boards RegistroVaciarConfirmar / …SinCuenta, not from
// the component. Seed and helpers are copied from registro-borrar.spec.ts.

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

const t = createTranslator({ locale: "es", messages });
const study = (key: string, values?: Record<string, string | number>) =>
  t(`log.study.${key}` as never, values as never) as string;
const clear = (key: string, values?: Record<string, string | number>) =>
  t(`log.clear.${key}` as never, values as never) as string;

type SeedLookup = Omit<LookupRecord, "id">;

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

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

// 4 searches, 3 words: leave (2 searches), leaf (1), left (1).
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
async function seed(page: Page, rows: { sync?: SyncState; lookups?: SeedLookup[] }): Promise<void> {
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

async function openRegistro(page: Page, seedRows: Parameters<typeof seed>[1]): Promise<() => number> {
  await deleteTranslator(page);
  await seed(page, seedRows);
  await page.goto("/registro");
  let loads = 0;
  page.on("load", () => (loads += 1));
  return () => loads;
}

// What a ✕ does to the store, minus the screen: drops every row of one group
// (`headword ?? normalised`) and tells the page, as `deleteStudyGroup` does.
async function dropGroup(page: Page, group: string): Promise<void> {
  await page.evaluate(
    ({ group, event }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          const cursor = tx.objectStore("lookups").openCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) return;
            const row = at.value as { headword: string | null; normalised: string };
            if ((row.headword ?? row.normalised) === group) at.delete();
            at.continue();
          };
          tx.oncomplete = () => {
            db.close();
            window.dispatchEvent(new Event(event));
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { group, event: LOG_DELETED_EVENT },
  );
}

// A row as the flush leaves it: written first, announced after.
function addRowScript(): (args: { row: unknown }) => Promise<void> {
  return ({ row }) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("reading-log");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("lookups", "readwrite");
        tx.objectStore("lookups").add(row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
}

function answerJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function zebraRound() {
  return {
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
  };
}

const trigger = (page: Page) => page.getByRole("button", { name: clear("trigger"), exact: true });
const keep = (page: Page) => page.getByRole("button", { name: clear("keep"), exact: true });
const body = (page: Page, words: number, lookups: number) =>
  page.getByText(clear("confirmBody", { words, lookups }), { exact: true });
const anyBody = (page: Page) => page.locator("p", { hasText: clear("confirmTitle") });
const deleteX = (page: Page, word: string) =>
  page.getByRole("button", { name: study("deleteRow", { word }), exact: true });
const action = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).or(page.getByRole("link", { name, exact: true }));

async function deleteViaUi(page: Page, word: string): Promise<void> {
  await deleteX(page, word).click();
  await action(page, study("deleteConfirm")).click();
}

test("Idle, a row deleted: the confirmation names the words and searches that are left", async ({ page }) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await expect(trigger(page)).toBeVisible();

  await deleteViaUi(page, "leave");
  await expect(deleteX(page, "leave")).toHaveCount(0);
  await trigger(page).click();
  await expect(body(page, 2, 2)).toBeVisible();
  expect(loads()).toBe(0);
});

test("Confirming, a row deleted under it: the body takes the new figures and the question stays open", async ({
  page,
}) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await trigger(page).click();
  await expect(body(page, 3, 4)).toBeVisible();

  await dropGroup(page, "leaf");
  await expect(body(page, 2, 3)).toBeVisible();
  await expect(keep(page)).toBeVisible();
  expect(loads()).toBe(0);
});

test("Empty after the last row: the trigger goes and the empty state shows", async ({ page }) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await expect(trigger(page)).toBeVisible();

  await deleteViaUi(page, "leave");
  await deleteViaUi(page, "leaf");
  await deleteViaUi(page, "left");
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  expect(loads()).toBe(0);
});

test("Empty after the last row, confirming: the open question goes with it", async ({ page }) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await trigger(page).click();
  await expect(keep(page)).toBeVisible();

  for (const group of ["leave", "leaf", "left"]) await dropGroup(page, group);
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  await expect(keep(page)).toHaveCount(0);
  await expect(anyBody(page)).toHaveCount(0);
  expect(loads()).toBe(0);
});

test("Done, rows landed by a pull: the trigger appears on an open screen", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [] });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, zebraRound());
  });

  const first = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await first;
  let loads = 0;
  page.on("load", () => (loads += 1));
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);

  release();
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  await expect(body(page, 1, 1)).toBeVisible();
  expect(loads).toBe(0);
});

test("A flush on an open screen: the confirmation's counts rise by one", async ({ page }) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await trigger(page).click();
  await expect(body(page, 3, 4)).toBeVisible();

  await page.evaluate(addRowScript(), { row: lookup("river") });
  await page.evaluate((event) => window.dispatchEvent(new Event(event)), LOG_FLUSHED_EVENT);
  await expect(body(page, 4, 5)).toBeVisible();
  await expect(keep(page)).toBeVisible();
  expect(loads()).toBe(0);
});

test("Stale reply: with the first read held and two events fired, the body shows the second's figures", async ({
  page,
}) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await trigger(page).click();
  await expect(body(page, 3, 4)).toBeVisible();

  // A readwrite transaction on `lookups` keeps every later read waiting.
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

  const fire = () =>
    page.evaluate((event) => window.dispatchEvent(new Event(event)), LOG_FLUSHED_EVENT);
  await fire();
  await page.waitForTimeout(200);
  // The write queues behind the hold, after the first read's transaction.
  await page.evaluate(
    ({ row }) => {
      (window as unknown as { __added: Promise<void> }).__added = new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("lookups", "readwrite");
          tx.objectStore("lookups").add(row);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { row: lookup("river") },
  );
  await page.waitForTimeout(200);
  await fire();
  await page.waitForTimeout(200);
  await expect(body(page, 3, 4), "nothing paints while the first read is held").toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __release: boolean }).__release = true;
  });
  await page.evaluate(() => (window as unknown as { __added: Promise<void> }).__added);
  await expect(body(page, 4, 5)).toBeVisible();
  expect(loads()).toBe(0);
});

test("Cancelled: «Conservarlo» closes the question and a later delete leaves it closed", async ({ page }) => {
  const loads = await openRegistro(page, { lookups: leaveRows() });
  await trigger(page).click();
  await expect(body(page, 3, 4)).toBeVisible();

  await keep(page).click();
  await expect(trigger(page)).toBeVisible();
  await expect(anyBody(page)).toHaveCount(0);

  await dropGroup(page, "leaf");
  await expect(deleteX(page, "leaf")).toHaveCount(0);
  await expect(trigger(page)).toBeVisible();
  await expect(anyBody(page)).toHaveCount(0);
  await expect(keep(page)).toHaveCount(0);
  expect(loads()).toBe(0);
});
