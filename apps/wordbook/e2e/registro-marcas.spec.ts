import { randomUUID } from "node:crypto";

import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { expect, studyHeader, test } from "./fixtures";

// RL-70, RL-66 (device half): a search another device deleted leaves this one
// when /registro opens with the copy on, the rows it held and the count above
// them with it, and the list repaints without a reload when the round brought
// marks and no row. Every answer of the route is the test's own: no session,
// no address, no database row.


type SeedLookup = Omit<LookupRecord, "id">;

const DEVICE = randomUUID();
const FOREIGN = randomUUID();

function row(word: string, extra: Partial<SeedLookup> = {}): SeedLookup {
  return {
    schema: 3,
    at: Date.now(),
    text: word,
    normalised: word,
    kind: "word",
    outcome: "exact",
    headword: word,
    rule: null,
    senses: 1,
    translation: null,
    dictionaryReady: true,
    origin: "device",
    ...extra,
  };
}

function copyOn(): SyncState {
  return {
    deviceId: DEVICE,
    pushedThroughLocalId: 99,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
  };
}

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// Seeds from the home screen: /registro reads the sync row on open and would
// race this write. Own rows take ids 1 and 3; the pulled one takes 2.
async function seed(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  const lookups = [
    row("alpha"), // id 1, this device's own
    row("zebra", { device: FOREIGN, deviceSeq: 7 }), // id 2, pulled
    row("mango"), // id 3, stays
  ];
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
            request.transaction!.objectStore("lookups").createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          }
          if (event.oldVersion < 3) {
            request.transaction!.objectStore("lookups").createIndex("headword", "headword");
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(["lookups", "sync"], "readwrite");
          tx.objectStore("sync").put({ ...sync, key: "state" });
          for (const lookup of lookups) tx.objectStore("lookups").add(lookup);
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

// Both marks and nothing else: no row comes down.
const marksOnly = {
  accepted: 0,
  rows: [],
  cursor: null,
  tombstones: [
    { deviceId: DEVICE, localId: 1 },
    { deviceId: FOREIGN, localId: 7 },
  ],
  tombstoneCursor: "2026-10-16T10:00:00.000Z|" + FOREIGN + "|7",
};

function answerJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

const rowLink = (page: Page, word: string) => page.locator(`a[href="/registro/${word}"]`);
const header = (page: Page, lookups: number, words: number) => studyHeader(page, lookups, words);

test("RL-70: marks another device made remove an own row and a pulled row here, and the header counts drop", async ({
  page,
}) => {
  await deleteTranslator(page);
  await seed(page);
  await page.route("**/api/log/sync", (route) => answerJson(route, marksOnly));

  await page.goto("/registro");
  await expect(rowLink(page, "mango")).toBeVisible();
  await expect(rowLink(page, "alpha")).toHaveCount(0);
  await expect(rowLink(page, "zebra")).toHaveCount(0);
  await expect(header(page, 1, 1)).toBeVisible();
  await expect(header(page, 3, 3)).toHaveCount(0);

  // Gone from the store, not only from the screen: a reload reads it again.
  await page.reload();
  await expect(rowLink(page, "mango")).toBeVisible();
  await expect(rowLink(page, "alpha")).toHaveCount(0);
  await expect(rowLink(page, "zebra")).toHaveCount(0);
});

test("RL-70: a round that brings marks and no row repaints the open list without a reload", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page);

  // The answer waits until the list has read once, so the rows can only leave
  // the screen by the list hearing the round land.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, marksOnly);
  });
  let loads = 0;
  page.on("load", () => (loads += 1));

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect(rowLink(page, "zebra")).toBeVisible();
  await expect(header(page, 3, 3)).toBeVisible();
  const loadsBefore = loads;

  release();
  await expect(rowLink(page, "alpha")).toHaveCount(0);
  await expect(rowLink(page, "zebra")).toHaveCount(0);
  await expect(rowLink(page, "mango")).toBeVisible();
  await expect(header(page, 1, 1)).toBeVisible();
  expect(loads, "the page reloaded to show the rows gone").toBe(loadsBefore);
});

test("RL-70: marks naming rows this device never held change nothing", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page);
  await page.route("**/api/log/sync", (route) =>
    answerJson(route, {
      ...marksOnly,
      tombstones: [
        { deviceId: DEVICE, localId: 50 },
        { deviceId: randomUUID(), localId: 7 },
      ],
    }),
  );
  const answered = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await answered;
  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect(rowLink(page, "zebra")).toBeVisible();
  await expect(rowLink(page, "mango")).toBeVisible();
  await expect(header(page, 3, 3)).toBeVisible();
});
