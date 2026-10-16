import { randomUUID } from "node:crypto";

import type { Page, Route } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { expect, test } from "./fixtures";

// Module 549, RNL-09, RL-22, RL-32: with the copy on, opening /registro sends
// one round to /api/log/sync and, if something came down, the list re-reads
// without a reload; with the copy off, nothing goes out. Written from the
// contract (docs/voyager/SPEC.md RNL-09, board RegistroEstudio: no indicator),
// not from the components. Every answer of the route is the test's own, so
// no session, no address and no database row is involved.

type SeedLookup = Omit<LookupRecord, "id">;

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

function localRow(text: string): SeedLookup {
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
  };
}

function copyOn(extra: Partial<SyncState> = {}): SyncState {
  return {
    deviceId: randomUUID(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId: randomUUID(),
    retired: false,
    ...extra,
  };
}

// Seeds from the home screen: /registro itself reads the sync row on open
// (and mints its device id when absent), which would race this write and put
// the default back over the seeded copy.
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

// Every POST the page issues to the copy route, read off the `request` event
// so a request the route later holds, fails or aborts still counts.
function trackSync(page: Page): { count: () => number } {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/log/sync") && request.method() === "POST") count += 1;
  });
  return { count: () => count };
}

function emptyRound() {
  return { accepted: 0, rows: [], cursor: null };
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

function answerJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const rowLink = (page: Page, word: string) => page.locator(`a[href="/registro/${word}"]`);

// A re-read that went through the skeleton would flash it for a frame the
// screenshot never catches; an observer on the body does.
async function watchSkeleton(page: Page): Promise<void> {
  await page.evaluate((needle) => {
    const w = window as unknown as { __skeletonSeen: boolean };
    w.__skeletonSeen = false;
    // `innerText`, not `textContent`: the latter reads the page's own script
    // payload, which carries every message of the app, skeleton words included.
    new MutationObserver(() => {
      if (document.body.innerText.includes(needle)) w.__skeletonSeen = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, messages.log.study.skeletonWord);
}

const skeletonSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __skeletonSeen: boolean }).__skeletonSeen);

test("RNL-09: with the copy on, opening /registro sends exactly one POST", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyRound()));
  const posts = trackSync(page);

  const first = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await first;
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "POSTs for one open of /registro").toBe(1);
});

test("RNL-09, RL-32: a row that came down appears in the open list without a reload and without the skeleton", async ({
  page,
}) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });

  // The answer waits until the list has read once, so the foreign row can
  // only reach the screen by the list hearing the sync land.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, zebraRound());
  });
  let loads = 0;
  page.on("load", () => (loads += 1));

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect(rowLink(page, "zebra")).toHaveCount(0);
  await watchSkeleton(page);
  const loadsBefore = loads;

  release();
  await expect(rowLink(page, "zebra")).toBeVisible();
  await expect(rowLink(page, "alpha")).toBeVisible();
  expect(loads, "the page reloaded to show the row").toBe(loadsBefore);
  expect(await skeletonSeen(page), "the populated list dropped back to the skeleton").toBe(false);
});

test("RNL-09: a round that brings nothing leaves the list untouched, never the skeleton", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/log/sync", async (route) => {
    await gate;
    await answerJson(route, emptyRound());
  });
  const posts = trackSync(page);

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await watchSkeleton(page);

  const answered = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  release();
  await answered;
  await page.waitForLoadState("networkidle");
  expect(posts.count()).toBe(1);
  expect(await skeletonSeen(page), "an empty round re-read the list through the skeleton").toBe(false);
  await expect(rowLink(page, "alpha")).toBeVisible();
});

test("RNL-09: one round per open: each visit sends one, re-rendering the screen sends none", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyRound()));
  const posts = trackSync(page);

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect.poll(posts.count).toBe(1);

  // The list re-reads on these events and re-renders; none is an open.
  await page.evaluate(() => {
    for (let i = 0; i < 3; i += 1) window.dispatchEvent(new Event("voyager:log-flushed"));
    window.dispatchEvent(new Event("resize"));
  });
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "re-rendering without navigating sent a round").toBe(1);

  // Leave and come back by the bar, a client navigation: a new open.
  const nav = page.getByRole("navigation", { name: messages.nav.label });
  await nav.getByRole("link", { name: messages.nav.search }).click();
  await expect(page.getByRole("textbox", { name: messages.search.label })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "the home screen must not sync").toBe(1);

  await nav.getByRole("link", { name: messages.nav.log }).click();
  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect.poll(posts.count).toBe(2);
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "one open sent more than one round").toBe(2);
});

test("RNL-09: with no account and no copy, opening /registro sends nothing", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { lookups: [localRow("alpha")] });
  const posts = trackSync(page);

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count()).toBe(0);
});

test("RNL-09, RL-22: a device already retired sends nothing on open", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn({ enabled: false, retired: true }), lookups: [localRow("alpha")] });
  const posts = trackSync(page);
  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "a device already retired sent a round").toBe(0);
});

test("RNL-09, RL-22: a 409 retired answer on open stops the next open from sending", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, { error: "retired" }, 409));
  const posts = trackSync(page);
  const first = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await first;
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count()).toBe(1);

  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count(), "a device the server retired tried again on the next open").toBe(1);
});

test("RNL-09: a failed round on open changes nothing on screen and is not retried", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, { error: "boom" }, 500));
  const posts = trackSync(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const answered = page.waitForResponse((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await expect(rowLink(page, "alpha")).toBeVisible();
  await watchSkeleton(page);
  await answered;
  await page.waitForLoadState("networkidle");

  await expect(rowLink(page, "alpha")).toBeVisible();
  await expect(page.getByText(messages.log.study.failedTitle)).toHaveCount(0);
  await expect(page.getByText(messages.account.copy.failedTitle)).toHaveCount(0);
  await expect(page.getByRole("button", { name: messages.log.study.failedAction })).toHaveCount(0);
  expect(await skeletonSeen(page)).toBe(false);
  expect(errors, "a failed round surfaced as an uncaught error").toEqual([]);
  expect(posts.count(), "a failed round was retried").toBe(1);
});

test("RNL-09, RL-16: with the network gone, the open's round fails quietly and the list reads", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("alpha")] });
  // What `fetch` meets offline: a rejected request, not an HTTP status. The
  // shell opening with no connection is `offline.spec.ts`'s to prove.
  await page.route("**/api/log/sync", (route) => route.abort("internetdisconnected"));
  const posts = trackSync(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const attempted = page.waitForRequest((r) => r.url().includes("/api/log/sync"));
  await page.goto("/registro");
  await attempted;
  await expect(rowLink(page, "alpha")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(messages.log.study.failedTitle)).toHaveCount(0);
  await expect(page.getByText(messages.account.copy.failedTitle)).toHaveCount(0);
  expect(errors, "a dropped connection surfaced as an uncaught error").toEqual([]);
  expect(posts.count(), "a dropped round was retried").toBe(1);
});

test("RNL-09: a word page under /registro does not sync", async ({ page }) => {
  await deleteTranslator(page);
  await seed(page, { sync: copyOn(), lookups: [localRow("apple")] });
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyRound()));
  const posts = trackSync(page);

  await page.goto("/registro/apple");
  await expect(page.getByRole("heading", { name: "apple" }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(posts.count()).toBe(0);
});
