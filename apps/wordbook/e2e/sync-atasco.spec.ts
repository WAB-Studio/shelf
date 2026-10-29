import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import manifest from "../public/dictionary/manifest.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";

// RL-24, RNL-09: the upload moves past foreign rows, cuts long ones, and stops
// for a retired device. No reader signs in: the driver only reads `enabled`,
// and every `/api/log/sync` answer is the test's own.

type SeedLookup = Omit<LookupRecord, "id">;

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function seedLocalDatabase(page: Page, sync: SyncState, lookups: SeedLookup[]): Promise<void> {
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
    { version: DATABASE_VERSION, sync, lookups },
  );
}

async function readSyncRow(page: Page): Promise<SyncState> {
  return page.evaluate(
    () =>
      new Promise<SyncState>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction("sync", "readonly").objectStore("sync").get("state");
          get.onsuccess = () => {
            db.close();
            resolve(get.result as SyncState);
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

function lookup(text: string, overrides: Partial<SeedLookup> = {}): SeedLookup {
  return {
    schema: 2,
    at: Date.now(),
    text,
    normalised: text,
    kind: "word",
    outcome: "miss",
    headword: null,
    rule: null,
    senses: 0,
    translation: null,
    dictionaryReady: true,
    origin: null,
    ...overrides,
  };
}

function enabledState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
    ...overrides,
  };
}

type Body = { rows: Array<{ text: string; normalised: string }> };

// Answers every sync POST with `status`/`body` and keeps what was sent.
async function interceptSync(page: Page, status: number, body: unknown): Promise<Body[]> {
  const posted: Body[] = [];
  await page.route("**/api/log/sync", async (route) => {
    posted.push(route.request().postDataJSON() as Body);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return posted;
}

const EMPTY_PAGE = { accepted: 0, rows: [], cursor: null };

async function openAndSeed(page: Page, sync: SyncState, lookups: SeedLookup[]): Promise<void> {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await seedLocalDatabase(page, sync, lookups);
}

test("RL-24: a stored row of 689 characters goes up cut to 500 and does not hold back the next one", async ({
  page,
}) => {
  const long = "a".repeat(689);
  await openAndSeed(page, enabledState(), [lookup(long), lookup("short")]);
  const posted = await interceptSync(page, 200, EMPTY_PAGE);

  const answered = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  await hideTab(page);
  await answered;

  expect(posted).toHaveLength(1);
  expect(posted[0].rows.map((row) => row.text.length)).toEqual([500, 5]);
  expect(posted[0].rows[0].normalised).toHaveLength(500);
});

test("RL-24: 600 foreign rows ahead of a local search do not keep the search from going up", async ({ page }) => {
  const foreign = Array.from({ length: 600 }, (_, i) =>
    lookup(`foreign-${i}`, { device: randomUUID(), deviceSeq: i + 1 }),
  );
  await openAndSeed(page, enabledState(), [...foreign, lookup("mine")]);
  const posted = await interceptSync(page, 200, EMPTY_PAGE);

  await hideTab(page);
  await expect.poll(() => posted.some((body) => body.rows.some((row) => row.text === "mine"))).toBe(true);
});

test("RL-24: a 409 retired marks the device retired, turns the copy off and sends nothing more", async ({
  page,
}) => {
  await openAndSeed(page, enabledState(), [lookup("mine")]);
  const posted = await interceptSync(page, 409, { error: "retired" });

  await hideTab(page);
  await expect.poll(async () => (await readSyncRow(page)).retired).toBe(true);

  const state = await readSyncRow(page);
  expect(state.enabled).toBe(false);
  expect(posted).toHaveLength(1);
});

test("RL-24: any other failure leaves both cursors where they were", async ({ page }) => {
  const before = enabledState({ pushedThroughLocalId: 0, pulledThroughCursor: "seed-cursor" });
  await openAndSeed(page, before, [lookup("mine")]);
  await interceptSync(page, 500, { error: "boom" });

  const response = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  await hideTab(page);
  await response;

  const state = await readSyncRow(page);
  expect(state.pushedThroughLocalId).toBe(0);
  expect(state.pulledThroughCursor).toBe("seed-cursor");
  expect(state.retired).toBe(false);
});
