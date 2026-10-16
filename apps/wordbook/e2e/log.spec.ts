import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";
import type { WorkerRequest, WorkerResponse } from "../lib/dictionary/worker-protocol";

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function exposeDictionaryWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class CapturingWorker extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        (window as unknown as { __dictionaryWorker?: Worker }).__dictionaryWorker = this;
      }
    }
    window.Worker = CapturingWorker as unknown as typeof Worker;
  });
}

type WorkerRequestShape = Extract<WorkerRequest, { kind: "lookup" }>;
type WorkerResponseShape = Extract<WorkerResponse, { kind: "answer" }> | { id?: number; kind: string };

let nextProbeId = 20_000_000;

async function measureWorkerRoundTrips(page: Page, count: number, text: string): Promise<number[]> {
  return page.evaluate(
    async ({ count, text, startId }) => {
      const worker = (window as unknown as { __dictionaryWorker: Worker }).__dictionaryWorker;
      const durations: number[] = [];
      for (let i = 0; i < count; i++) {
        const id = startId + i;
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent<WorkerResponseShape>) => {
            if (event.data.id !== id || event.data.kind !== "answer") return;
            worker.removeEventListener("message", onMessage);
            durations.push(performance.now() - start);
            resolve();
          };
          worker.addEventListener("message", onMessage);
          worker.postMessage({ id, kind: "lookup", text } satisfies WorkerRequestShape);
        });
      }
      return durations;
    },
    { count, text, startId: (nextProbeId += count * 2) - count * 2 },
  );
}

function percentile(durations: readonly number[], p: number): number {
  const sorted = [...durations].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

// Raw IndexedDB, mirroring `lib/log/record.ts`'s own shape — this file may
// not import it (it runs inside `page.evaluate`, a browser context no Node
// import reaches), so it opens the same database by name instead.
async function readLogRows(
  page: Page,
): Promise<
  Array<{ normalised: string; outcome: string; dictionaryReady: boolean; senses: number; translation: string | null }>
> {
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

// No version pinned and no `onupgradeneeded`: every caller navigates first,
// so the store already exists at whatever version the app itself opened.
async function seedLocalRows(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
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
    count,
  );
}

const PEER_DEVICE = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const FOREIGN_TOTAL = 10_000;
const PAGE = 500;
const FINAL_CURSOR = `page-${FOREIGN_TOTAL / PAGE}`;

// The account's side of `/api/log/sync`, as the wire schema
// (`lib/sync/protocol.ts`) defines it: 500 peer rows per round, then an empty
// round that ends the driver's loop. The cursor is opaque to the driver.
function foreignPage(since: string | null): { accepted: number; rows: unknown[]; cursor: string } {
  const index = since ? Number(since.replace("page-", "")) : 0;
  const rows = [];
  for (let i = index * PAGE; i < Math.min((index + 1) * PAGE, FOREIGN_TOTAL); i++) {
    rows.push({
      deviceId: PEER_DEVICE,
      localId: i + 1,
      at: Date.now() - i,
      text: `foreign-${i}`,
      normalised: `foreign-${i}`,
      kind: "word",
      outcome: "exact",
      headword: `foreign-${i}`,
      rule: null,
      senses: 1,
      translation: null,
      dictionaryReady: true,
      origin: "device",
      recordSchema: 2,
      definition: null,
      exampleEn: null,
      exampleEs: null,
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    });
  }
  return { accepted: 0, rows, cursor: `page-${Math.min(index + 1, FOREIGN_TOTAL / PAGE)}` };
}

async function readSyncRow(page: Page): Promise<{ pulledThroughCursor: string | null; enabled: boolean } | undefined> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction("sync", "readonly").objectStore("sync").get("state");
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

async function enableCopy(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("sync", "readwrite");
          tx.objectStore("sync").put({
            key: "state",
            deviceId: crypto.randomUUID(),
            pushedThroughLocalId: null,
            pulledThroughCursor: null,
            lastSyncedAt: null,
            enabled: true,
            readerId: "00000000-0000-4000-8000-000000000001",
            retired: false,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

// `SyncOnHide` (in the layout) is the trigger a real reader reaches by
// switching tabs; a headless page is never hidden by itself.
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// Starts one worker lookup every 5 ms in the page and returns at once;
// `stopProbe` ends the loop and hands back every latency. Each latency runs
// from the moment its lookup was due, not from when it was sent: a main thread
// held up by the merge delays the later ticks too, and they all show it.
async function startProbe(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ text, startId }) => {
      const worker = (window as unknown as { __dictionaryWorker: Worker }).__dictionaryWorker;
      const probe = { stop: false, durations: [] as number[], done: Promise.resolve() };
      (window as unknown as { __probe: typeof probe }).__probe = probe;
      probe.done = (async () => {
        const origin = performance.now();
        for (let tick = 0; !probe.stop; tick++) {
          const due = origin + tick * 5;
          const wait = due - performance.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          const id = startId + tick;
          await new Promise<void>((resolve) => {
            const onMessage = (event: MessageEvent<{ id?: number; kind: string }>) => {
              if (event.data.id !== id || event.data.kind !== "answer") return;
              worker.removeEventListener("message", onMessage);
              probe.durations.push(performance.now() - Math.max(due, origin));
              resolve();
            };
            worker.addEventListener("message", onMessage);
            worker.postMessage({ id, kind: "lookup", text });
          });
        }
      })();
    },
    { text, startId: (nextProbeId += 10_000_000) },
  );
}

async function stopProbe(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const probe = (window as unknown as { __probe: { stop: boolean; durations: number[]; done: Promise<void> } }).__probe;
    probe.stop = true;
    await probe.done;
    return probe.durations;
  });
}

test("every lookup that finds an answer is recorded, a miss leaves no row, a fat log costs nothing, and a lost log costs nothing either", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  await exposeDictionaryWorker(page);

  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  // RL-17 / RNL-06's guard: five keystrokes under the 800ms settle fold into
  // one row, not a deck full of "thro" and "throu".
  await searchBox.pressSequentially("throughout", { delay: 30 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const afterWord = await readLogRows(page);
  expect(afterWord.filter((row) => row.normalised === "throughout")).toHaveLength(1);
  expect(afterWord).toHaveLength(1);

  // A word the dictionary carries nothing for: RL-39 leaves no row for a
  // miss, so the log stays at the one row "throughout" already wrote.
  await searchBox.fill("zzqxplorph");
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const afterMiss = await readLogRows(page);
  expect(afterMiss.find((row) => row.normalised === "zzqxplorph")).toBeUndefined();
  expect(afterMiss).toHaveLength(1);

  // A query typed while the install is still running: a second page shares
  // the same origin's storage, so its row lands beside the first one. A
  // real headword, not a miss — RL-39 leaves nothing to inspect on a miss,
  // and this row's `dictionaryReady` is the whole point of the test.
  const installingPage = await context.newPage();
  await deleteTranslator(installingPage);
  await installingPage.route(`**${manifest.asset.path}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await installingPage.goto("/");
  const installingBox = installingPage.getByRole("textbox", { name: messages.search.label });
  await installingBox.fill("apple");
  // The keystroke's own `dictionaryReady` flag is read synchronously, at
  // type time — long before this settles, however long the install takes.
  // Waiting for the answer to render proves the worker actually reached
  // this query, queued behind the delayed install, before the box is
  // cleared to force the row's flush.
  await expect(installingPage.getByRole("heading", { name: "apple" })).toBeVisible({ timeout: 8000 });
  await installingBox.fill("");
  await installingPage.waitForTimeout(300);
  await installingPage.close();

  const afterInstalling = await readLogRows(page);
  const installingRow = afterInstalling.find((row) => row.normalised === "apple");
  expect(installingRow?.dictionaryReady).toBe(false);

  // The guard that matters: 10,000 rows already in the log, and the worker's
  // own round trip is unmoved — it never reads this database at all.
  await seedLocalRows(page, 10_000);

  const seededCount = (await readLogRows(page)).length;
  expect(seededCount).toBe(10_002);

  const durations = await measureWorkerRoundTrips(page, 200, "throughout");
  const p95 = percentile(durations, 95);
  console.log(`RNL-01 worker round trip, 200 lookups, log at 10,002 rows — p95 ${p95.toFixed(3)} ms`);
  expect(p95).toBeLessThan(10);

  // A lost log, mid-session: force-clear IndexedDB the way a browser's own
  // storage eviction would — bypassing the polite `versionchange` handshake
  // `lib/log/record.ts` never listens for, which a plain `deleteDatabase()`
  // would instead block on forever behind the page's own open connection.
  const client = await context.newCDPSession(page);
  await client.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "indexeddb",
  });

  // The worker already holds its index in memory; a lookup answers exactly
  // as before, and nothing about the vanished log reaches the page as an
  // unhandled rejection (RNL-06: a failed write is swallowed, not thrown).
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  expect(pageErrors).toEqual([]);
});

// The merge is the app's own: `SyncOnOpen` calls `syncNow`, the driver posts to
// `/api/log/sync` (answered here, per page, for this browser alone) and hands
// the pages to `mergeForeign`. Nothing in this spec inserts a row itself.
test("RNL-01: a lookup answers in under 10ms at the median and at the 95th percentile while the app merges 10,000 rows from the account", async ({
  page,
}) => {
  await deleteTranslator(page);
  await exposeDictionaryWorker(page);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rounds = 0;
  await page.route("**/api/log/sync", async (route) => {
    const body = route.request().postDataJSON() as { since: string | null };
    // The first round waits, so the probe is already running when the merge starts.
    if (rounds++ === 0) await gate;
    await route.fulfill({ json: foreignPage(body.since) });
  });

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // `reading-log` opens lazily, on the first settled query: one throwaway
  // lookup stands up the v3 schema and the app mints its device row.
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.pressSequentially("primer", { delay: 30 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  // The copy is switched on in storage; the tab then hides, which is what runs
  // the driver for a signed-in reader. The first round waits at the gate.
  await enableCopy(page);
  await hideTab(page);
  await expect.poll(() => rounds).toBe(1);

  const worker = await measureWorkerRoundTrips(page, 3, "throughout");
  expect(worker).toHaveLength(3);
  await startProbe(page, "throughout");
  release();

  await expect
    .poll(async () => (await readSyncRow(page))?.pulledThroughCursor, { timeout: 60_000 })
    .toBe(FINAL_CURSOR);
  const durations = await stopProbe(page);

  expect(durations.length).toBeGreaterThan(50);
  const median = percentile(durations, 50);
  console.log(`RNL-01 worker round trip during the app's own 10,000-row merge — ${durations.length} lookups, median ${median.toFixed(3)} ms, p95 ${percentile(durations, 95).toFixed(1)} ms, max ${Math.max(...durations).toFixed(1)} ms`);
  expect(median).toBeLessThan(10);
  expect(percentile(durations, 95)).toBeLessThan(10);

  const foreign = (await readLogRows(page)).filter((row) => row.normalised.startsWith("foreign-"));
  expect(foreign).toHaveLength(FOREIGN_TOTAL);
});

test("RL-34: a word's stored translation spans senses, and the 120-char cut between glosses still wins over the 3-sense cap", async ({
  page,
}) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  // "back" carries four senses (v, n, adj, adv). Its first sense alone never
  // reaches 120 characters, so a translation reaching "dorso" — the noun
  // sense's own second gloss, not a substring of anything the verb sense
  // carries — is the only way this row proves the second sense was kept,
  // not just the first one over budget.
  await searchBox.fill("back");
  await expect(page.getByRole("heading", { name: "back" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const backRow = (await readLogRows(page)).find((row) => row.normalised === "back");
  expect(backRow?.senses).toBe(4);
  expect(backRow?.translation).toContain("dorso");
  expect(backRow?.translation?.length).toBeLessThanOrEqual(120);

  // A one-sense headword whose glosses alone run to 154 raw characters: the
  // cut lands after the last whole gloss that fits, unmoved by the sense cap.
  await searchBox.fill("the road to hell is paved with good intentions");
  await expect(page.getByRole("heading", { name: "the road to hell is paved with good intentions" })).toBeVisible({
    timeout: 5000,
  });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const idiomRow = (await readLogRows(page)).find(
    (row) => row.normalised === "the road to hell is paved with good intentions",
  );
  expect(idiomRow?.senses).toBe(1);
  expect(idiomRow?.translation).toBe(
    "el camino al infierno está empedrado de buenas intenciones, el infierno está empedrado de buenas intenciones",
  );

  // "anyway" carries one sense whose raw glosses run to 195 characters, and
  // the 120-char cut lands right after "comoquiera, " — a separator, not a
  // letter. The stored row must not carry that dangling ", " onward.
  await searchBox.fill("anyway");
  await expect(page.getByRole("heading", { name: "anyway" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const anywayRow = (await readLogRows(page)).find((row) => row.normalised === "anyway");
  expect(anywayRow?.senses).toBe(1);
  expect(anywayRow?.translation).toBe(
    "en fin, pero bueno, pues nada, de todas formas, de todos modos, de todas maneras, a pesar de todo, aun así, comoquiera",
  );
  expect(anywayRow?.translation).not.toMatch(/[,\s]$/);
  expect(anywayRow?.translation?.length).toBeLessThanOrEqual(120);
});

test("a killed tab still commits the query it had settled on, and a fast one still groups by prefix", async ({
  page,
  context,
}) => {
  // `./fixtures` already stubs both routes on the context, not the page:
  // `reopened` and `finalPage` below are new pages this same test opens
  // with `context.newPage()`, and they inherit it with nothing extra here.
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  // Past the 800ms settle, short of the 5000ms forced flush: only the
  // `pagehide` path below, not a timer, can be what lands this row.
  await searchBox.fill("lemon");
  await page.waitForTimeout(2000);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto("/");
  const rowsAfterClose = await readLogRows(reopened);
  expect(rowsAfterClose.some((row) => row.normalised === "lemon")).toBe(true);

  // The regression the fix must not open: four keystrokes chained well
  // under the settle window, killed mid-chain, must still land as one row.
  const chainedBox = reopened.getByRole("textbox", { name: messages.search.label });
  for (const step of ["b", "bo", "boo", "book"]) {
    await chainedBox.fill(step);
    await reopened.waitForTimeout(150);
  }
  await reopened.close();

  const finalPage = await context.newPage();
  await finalPage.goto("/");
  const rowsAfterChain = await readLogRows(finalPage);
  expect(rowsAfterChain.filter((row) => row.normalised.startsWith("b"))).toHaveLength(1);
  expect(rowsAfterChain.find((row) => row.normalised === "book")).toBeTruthy();
});

// The killed-tab test above proves only `page.close()`: a document torn
// down by a reload, a URL navigation or a history traversal is a different
// death, one `pagehide`'s own IndexedDB write can lose even after it starts
// (docs/TRAPS.md). Each of the three gets its own test, never one shared
// one, so a regression in a single path still fails on its own.

test("a reload still commits the query it had settled on", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  // Past the 800ms settle, short of the 5000ms forced flush: only the
  // reload path below, not a timer, can be what lands this row.
  await searchBox.fill("lemon");
  await page.waitForTimeout(2000);
  await page.reload();

  const rows = await readLogRows(page);
  expect(rows.some((row) => row.normalised === "lemon")).toBe(true);
});

test("a URL navigation to another route still commits the query it had settled on", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("lemon");
  await page.waitForTimeout(2000);
  await page.goto("/cuenta");

  const rows = await readLogRows(page);
  expect(rows.some((row) => row.normalised === "lemon")).toBe(true);
});

test("going back in the history still commits the query it had settled on", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("lemon");
  await page.waitForTimeout(2000);
  await page.goto("/cuenta");
  await page.goBack();
  // `goBack()` itself resolves once the browser commits the navigation;
  // the app's own client router still re-renders `/` a task after that,
  // which is a second, brief execution-context churn `readLogRows` below
  // must not race.
  await page.waitForURL((url) => url.pathname === "/");

  const rows = await readLogRows(page);
  expect(rows.some((row) => row.normalised === "lemon")).toBe(true);
});

test("a reload still groups four keystrokes chained under the settle window into one row", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // The regression the relay must not open: four keystrokes chained well
  // under the settle window, killed by a reload mid-chain, must still land
  // as the one row the last of them named, never four.
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  for (const step of ["b", "bo", "boo", "book"]) {
    await searchBox.fill(step);
    await page.waitForTimeout(150);
  }
  await page.reload();

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.normalised.startsWith("b"))).toHaveLength(1);
  expect(rows.find((row) => row.normalised === "book")).toBeTruthy();
});

// Regression for PR #132: its guard sat on the call to `recordLookup`
// instead of on `commit`, so a miss never displaced the last *answered*
// prefix out of `pending` — that prefix sat there until the reader
// abandoned the box for something else entirely, and was written then.
// "asd" is `ASD`'s own headword, lower-cased (`normaliseHeadword`), and a
// real entry — translation "TEA" — so typing on to "asdkjhqwe" (a miss)
// and leaving reproduces exactly what a live drive of `integracion` found:
// `asd | exact | TEA`, a row the reader never searched for.
test("a headword typed on into nonsense and abandoned leaves no row, not the headword it passed through", async ({
  page,
}) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.pressSequentially("asdkjhqwe", { delay: 30 });
  // Past the 800ms settle: "asd" (a hit) has already been displaced from
  // `pending` by "asdkjhqwe" (a miss) through the strict-prefix merge in
  // `settleCandidate`, well before either navigation below runs.
  await page.waitForTimeout(1000);

  // The relay `commit` would otherwise write before either IndexedDB path
  // is tried (`record.ts`): a miss must never reach it, or a reload could
  // resurrect the very row this test proves never lands.
  const relayedBeforeLeaving = await page.evaluate(() => window.localStorage.getItem("voyager:pending-log-row"));
  expect(relayedBeforeLeaving).toBeNull();

  // The reported reproduction itself: leave for `/registro` with the box
  // still full of "asdkjhqwe" — a full navigation, so `pagehide` is what
  // fires `flushPendingLookup`, the same path a reload or a killed tab
  // takes, never a client-side route change this screen would just unmount
  // from instead.
  await page.goto("/registro");

  const rows = await readLogRows(page);
  expect(rows.find((row) => row.normalised === "asd")).toBeUndefined();
  expect(rows.find((row) => row.normalised === "asdkjhqwe")).toBeUndefined();
  expect(rows).toHaveLength(0);

  const relayedAfterLeaving = await page.evaluate(() => window.localStorage.getItem("voyager:pending-log-row"));
  expect(relayedAfterLeaving).toBeNull();
});

test("book, an emptied box, then cat leaves exactly two rows, one per word", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  await searchBox.fill("book");
  await expect(page.getByRole("heading", { name: "book" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  await searchBox.fill("cat");
  await expect(page.getByRole("heading", { name: "cat" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const rows = await readLogRows(page);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.normalised === "book")).toBeTruthy();
  expect(rows.find((row) => row.normalised === "cat")).toBeTruthy();
});

test("a word typed slowly enough to have crossed the retired 5s ceiling still lands as one row", async ({
  page,
}) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // The reported reproduction, unchanged: "weight" typed one letter at a
  // time with 2200ms between keystrokes is the exact gap that used to split
  // the chain in two ("wei", then "weight") once `record.ts`'s retired
  // `MAX_PENDING_MS` fired mid-word. The chain now closes only where the
  // box empties, this screen unmounts, the tab hides or the page unloads —
  // never on a clock — so six keystrokes spanning 13s+ still owe one row.
  const word = "weight";
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  for (let length = 1; length <= word.length; length++) {
    await searchBox.fill(word.slice(0, length));
    await page.waitForTimeout(2200);
  }
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.normalised.startsWith("w"))).toHaveLength(1);
  expect(rows.find((row) => row.normalised === "weight")).toBeTruthy();
});

test("the same word typed at ordinary speed, 120ms per keystroke, still lands as one row", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // The other timing named in the regression: fast enough that every
  // intermediate prefix's own lookup answer can still land before the next
  // keystroke, none of it past the 800ms settle — the strict-prefix merge
  // in `settleCandidate` is what has to fold "w" through "weight" into one
  // row here, not a gap wide enough to let each settle on its own.
  const word = "weight";
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.pressSequentially(word, { delay: 120 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.normalised.startsWith("w"))).toHaveLength(1);
  expect(rows.find((row) => row.normalised === "weight")).toBeTruthy();
});

// Regression for the list-based relay (2026-09-10): `flushPendingLookup` can
// commit two rows in the same synchronous pass — "book", displaced from
// `pending` by a non-prefix word, and "cat", the word that displaced it. A
// relay holding one key overwrote "book" with "cat" before "book"'s own
// IndexedDB transaction had a chance to survive the teardown that follows,
// and the next document recovered only "cat". The 0/200/400 ms matrix over
// these two teardowns is `lib/log/record.test.ts`; each real teardown is
// driven once here, at 0 ms, the tightest gap.
for (const teardown of ["goto", "reload"] as const) {
  test(`book, then cat with no empty box between them, torn down by a ${teardown} at once, leaves both rows`, async ({
    page,
  }) => {
    await deleteTranslator(page);
    const assetResponse = page.waitForResponse(
      (response) => response.url().includes(manifest.asset.path) && response.ok(),
    );
    await page.goto("/");
    await assetResponse;
    await page.waitForTimeout(1000);

    const searchBox = page.getByRole("textbox", { name: messages.search.label });
    await searchBox.fill("book");
    // Past the 800ms settle: "book" is `pending` before "cat" displaces it.
    await page.waitForTimeout(1200);
    // Replace the box's whole content, never emptying it first.
    await searchBox.fill("cat");

    if (teardown === "goto") {
      await page.goto("/registro");
    } else {
      await page.reload();
    }

    const rows = await readLogRows(page);
    expect(rows.find((row) => row.normalised === "book")).toBeTruthy();
    expect(rows.find((row) => row.normalised === "cat")).toBeTruthy();
  });
}

test("three words answered in a row with no empty box between them, abandoned cold, leave three rows", async ({
  page,
}) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // Each word given its own full settle before the next replaces it: the
  // relay never has to hold more than one row at a time here, unlike the
  // matrix above. This is the ordinary chain the list-based relay must
  // still not break — three separate words, three separate rows.
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("book");
  await page.waitForTimeout(1200);
  await searchBox.fill("cat");
  await page.waitForTimeout(1200);
  await searchBox.fill("lemon");
  await page.waitForTimeout(1200);
  await page.goto("/registro");

  const rows = await readLogRows(page);
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.normalised === "book")).toBeTruthy();
  expect(rows.find((row) => row.normalised === "cat")).toBeTruthy();
  expect(rows.find((row) => row.normalised === "lemon")).toBeTruthy();
});

test("one word, no navigating away, leaves exactly one row, not a duplicate from the relay", async ({ page }) => {
  await deleteTranslator(page);
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);

  // Emptying the box is what commits "lemon" here, the same trigger the
  // "book, an emptied box, then cat" test above uses: nothing tears the
  // page down, so `writeRowSync`'s own `oncomplete` clears its relay entry
  // well within this wait.
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("lemon");
  await expect(page.getByRole("heading", { name: "lemon" })).toBeVisible({ timeout: 5000 });
  await searchBox.fill("");
  await page.waitForTimeout(300);

  const relayed = await page.evaluate(() => window.localStorage.getItem("voyager:pending-log-row"));
  expect(relayed).toBeNull();

  // A later reload is not the teardown "lemon" was ever at risk from — its
  // own relay entry already cleared once `oncomplete` ran — so
  // `recoverRelayedRow` on this next document finds nothing to replay. A
  // relay that failed to drop a landed row would write it a second time.
  await page.reload();

  const rows = await readLogRows(page);
  expect(rows.filter((row) => row.normalised === "lemon")).toHaveLength(1);
});

// The relay held one bare object until 2026-09-10, when it became a list so
// a flush that commits two rows stops losing the first. A reader whose row
// was in flight across that deploy has the old shape on disk and exactly one
// document left to recover it in: reading it as a list of one is what keeps
// that row instead of dropping it on the version boundary.
test("a relay left in the pre-list shape is still recovered, not discarded", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/");
  await page.waitForFunction(() => document.querySelector("input") !== null);

  await page.evaluate(() => {
    window.localStorage.setItem(
      "voyager:pending-log-row",
      JSON.stringify({
        at: Date.now(),
        text: "relayshape",
        normalised: "relayshape",
        kind: "word",
        outcome: "exact",
        headword: "relayshape",
        rule: null,
        senses: 1,
        translation: "forma del relevo",
        dictionaryReady: true,
        origin: null,
        schema: 2,
      }),
    );
  });

  await page.reload();
  await expect
    .poll(async () => (await readLogRows(page)).filter((row) => row.normalised === "relayshape").length)
    .toBe(1);
  expect(await page.evaluate(() => window.localStorage.getItem("voyager:pending-log-row"))).toBeNull();
});
