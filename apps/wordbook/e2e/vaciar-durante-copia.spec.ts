import { randomUUID } from "node:crypto";
import path from "node:path";

import { createTranslator } from "next-intl";
import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { expect, test } from "./fixtures";

// M32 («vaciar» waits for a sync round): the local wipe runs under the sync's
// Web Lock, so a copy in flight finishes merging first and none of its rows
// come back after it. Written from the plan's contract and Done table, not from
// the component. The round is held by `page.route` until the test releases it.

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

const t = createTranslator({ locale: "es", messages });
const study = (key: string) => t(`log.study.${key}` as never) as string;
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

// Nothing local is left to upload: the round only downloads.
function copyOn(): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: 1_000_000,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
  };
}

function rows(): SeedLookup[] {
  return [lookup("leave"), lookup("leaf"), lookup("left")];
}

const trigger = (page: Page) => page.getByRole("button", { name: clear("trigger"), exact: true });
// Signed out, the one local action reads `soleAction`; signed in, `localAction`.
const wipeLocal = (page: Page) =>
  page
    .getByRole("button", { name: clear("soleAction"), exact: true })
    .or(page.getByRole("button", { name: clear("localAction"), exact: true }));
const wiping = (page: Page) => page.getByRole("button", { name: clear("wiping"), exact: true });

const lookupCount = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction("lookups").objectStore("lookups").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );

// Resolves once every lock request queued before it has run.
const afterLockQueue = (page: Page) => page.evaluate(() => navigator.locks.request("voyager-sync", () => undefined));

async function holdRound(page: Page): Promise<{ release: () => void; seen: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, zebraRound());
  });
  const seen = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  return { release, seen };
}

test("Pending round: while the sync route is held, «Vaciar» confirms and shows «Vaciando…»", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: rows() });
  const round = await holdRound(page);
  await page.goto("/registro");
  await round.seen;

  await trigger(page).click();
  await wipeLocal(page).click();
  await expect(wiping(page)).toBeVisible();
  // The round holds the lock, so nothing was wiped yet.
  expect(await lookupCount(page)).toBe(3);

  round.release();
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
});

test("Done after release: the round merges first, then the wipe, and the log stays empty", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: rows() });
  const round = await holdRound(page);
  await page.goto("/registro");
  await round.seen;

  await trigger(page).click();
  await wipeLocal(page).click();
  await expect(wiping(page)).toBeVisible();

  round.release();
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  await afterLockQueue(page);
  expect(await lookupCount(page), "the round's downloaded row came back after the wipe").toBe(0);
  await expect(trigger(page)).toHaveCount(0);
});

test("No lock API: with navigator.locks absent, «Vaciar» still empties", async ({ page }) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true });
  });
  await seed(page, { lookups: rows() });
  await page.goto("/registro");
  expect(await page.evaluate(() => navigator.locks)).toBeUndefined();

  await trigger(page).click();
  await wipeLocal(page).click();
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  expect(await lookupCount(page)).toBe(0);
});

test("Failed: a store that refuses to clear shows the failed line and a retry", async ({ page }) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    IDBObjectStore.prototype.clear = () => {
      throw new Error("forced");
    };
  });
  await seed(page, { lookups: rows() });
  await page.goto("/registro");

  await trigger(page).click();
  await wipeLocal(page).click();
  await expect(page.getByRole("alert").filter({ hasText: clear("failed") })).toBeVisible();
  await expect(page.getByRole("button", { name: clear("retry"), exact: true })).toBeVisible();
  expect(await lookupCount(page)).toBe(3);
});

// A round that never answers must not hold «Vaciar» hostage: the sync's fetch
// times out (20 s), the lock frees and the wipe lands.
test("Hung round: a sync route that never answers still lets «Vaciar» end, and the person can act again", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: rows() });
  await page.route("**/api/log/sync", () => new Promise<void>(() => undefined));
  const seen = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await seen;

  await trigger(page).click();
  await wipeLocal(page).click();
  await expect(wiping(page)).toBeVisible();

  // Either end frees the person: done (empty log) or failed (retry shown).
  const done = page.getByText(study("emptyTitle"), { exact: true });
  const failed = page.getByRole("alert").filter({ hasText: clear("failed") });
  await expect(done.or(failed)).toBeVisible({ timeout: 40_000 });
  await expect(wiping(page)).toHaveCount(0);
});
