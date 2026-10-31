import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { createTranslator } from "next-intl";
import type { Page, Route } from "@playwright/test";
import postgres from "postgres";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import { LOG_DELETED_EVENT } from "../lib/log/delete";
import type { LookupRecord, SyncState } from "../lib/log/types";
import { closeRun, openRun } from "@repo/harness-registry";
import { afterFrames, expect, freezeTimers, runClock, studyHeader, test } from "./fixtures";

// K10, RL-66, RL-70, RNL-11: each /registro row carries a ✕ that deletes its
// group. Written from SPEC RL-66/RL-70, RNL-11 (successor of RNL-09, approved
// 2026-10-17) and the boards RegistroBorrarFila, RegistroBorrarFilaConfirmar,
// RegistroBorrarFilaFallo and RegistroBorrarFilaSinCuenta, not from the component. Names come from the message catalogue through the
// same ICU runtime the app renders with.

try {
  process.loadEnvFile(path.join(__dirname, "../.env.local"));
} catch {
  // No .env.local: whatever the shell already exported.
}

const t = createTranslator({ locale: "es", messages });
const study = (key: string, values?: Record<string, string | number>) =>
  t(`log.study.${key}` as never, values as never) as string;

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

// Groups by `headword ?? normalised`, the registro's own key:
//   leave (2 searches): "leave" and "left" (an inflected form that reached it)
//   leaf  (1): the string "leave" typed, which reached `leaf`
//   left  (1): "left", its own entry
// 4 searches, 3 words. Deleting by the typed string instead of the group
// takes the wrong rows in both directions.
function leaveRows(): SeedLookup[] {
  return [
    lookup("leave"),
    lookup("left", { headword: "leave", outcome: "inflected", rule: "past" }),
    lookup("leave", { headword: "leaf", outcome: "inflected", rule: "plural" }),
    lookup("left"),
  ];
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

async function readLookups(page: Page): Promise<Array<LookupRecord & { id: number }>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction("lookups", "readonly").objectStore("lookups").getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

async function syncKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const keys = db.transaction("sync", "readonly").objectStore("sync").getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve(keys.result.map(String));
          };
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
}

const shape = (rows: Array<LookupRecord>) =>
  rows.map((row) => `${row.normalised}>${row.headword ?? "-"}`).sort();

async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function answerJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
const emptyRound = { accepted: 0, rows: [], cursor: null };

type Mark = { deviceId: string; localId: number };
// Every POST to the copy route, with the marks its body carried.
function trackRounds(page: Page): { count: () => number; bodies: Array<{ tombstones: Mark[] }> } {
  const bodies: Array<{ tombstones: Mark[] }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/log/sync") && request.method() === "POST") {
      bodies.push(request.postDataJSON() as { tombstones: Mark[] });
    }
  });
  return { count: () => bodies.length, bodies };
}

const rowLink = (page: Page, word: string) => page.locator(`a[href="/registro/${word}"]`);
const deleteX = (page: Page, word: string) =>
  page.getByRole("button", { name: study("deleteRow", { word }), exact: true });
// «Conservar», «Borrar» and «Reintentar» are a button or a link by name; the
// boards call two of them links. Exact: «Borrar» is a prefix of the ✕'s name.
const action = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).or(page.getByRole("link", { name, exact: true }));
const confirmTitle = (page: Page, word: string) =>
  page.getByText(study("deleteConfirmTitle", { word }), { exact: true });
const header = (page: Page, lookups: number, words: number) => studyHeader(page, lookups, words);
// The two bodies differ only by « en todos tus dispositivos»: exact or nothing.
const bodyEveryDevice = (page: Page, count: number) =>
  page.getByText(study("deleteConfirmBody", { count }), { exact: true });
const bodyThisDevice = (page: Page, count: number) =>
  page.getByText(study("deleteConfirmBodyLocal", { count }), { exact: true });
const localNote = (page: Page) => page.getByText(study("deleteConfirmLocalNote"), { exact: true });

// Every POST to the copy route answers an empty round: a random reader never
// meets the server, so no 409 rewrites the seeded state under the question.
async function answerRoundsEmpty(page: Page): Promise<void> {
  await page.route("**/api/log/sync", (route) => answerJson(route, emptyRound));
}

function apiRequests(page: Page): string[] {
  const api: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url());
  });
  return api;
}

const groupIds = async (page: Page, key: string) =>
  (await readLookups(page)).filter((row) => (row.headword ?? row.normalised) === key).map((row) => row.id).sort();
const sentMarks = (bodies: Array<{ tombstones: Mark[] }>) =>
  bodies.flatMap((body) => body.tombstones.map((mark) => mark.localId)).sort();

async function openRegistro(page: Page, seedRows: Parameters<typeof seed>[1]): Promise<void> {
  await deleteTranslator(page);
  await seed(page, seedRows);
  await page.goto("/registro");
}

async function deleteViaUi(page: Page, word: string): Promise<void> {
  await deleteX(page, word).click();
  await action(page, study("deleteConfirm")).click();
}

async function countDeletedEvents(page: Page): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as { __deleted: number };
    w.__deleted = 0;
    window.addEventListener(name, () => (w.__deleted += 1));
  }, LOG_DELETED_EVENT);
}
const deletedEvents = (page: Page) =>
  page.evaluate(() => (window as unknown as { __deleted: number }).__deleted);

// ---------------------------------------------------------------- Idle

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1280, height: 800 },
]) {
  test(`Idle (${viewport.width}): every row has a ✕ named with its word, at least 44 px, beside its link and never inside it; the word still opens its page`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openRegistro(page, { lookups: leaveRows() });
    for (const word of ["leave", "leaf", "left"]) {
      await expect(rowLink(page, word)).toBeVisible();
      const button = deleteX(page, word);
      await expect(button, `✕ of ${word}`).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.width, `${word} ✕ width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${word} ✕ height`).toBeGreaterThanOrEqual(44);
      const link = (await rowLink(page, word).boundingBox())!;
      expect(box.x + box.width / 2, `${word} ✕ sits right of the link`).toBeGreaterThanOrEqual(link.x + link.width);
      if (viewport.width >= 1280) {
        const centre = box.y + box.height / 2;
        expect(centre, `${word}: one line, ✕ level with the link`).toBeGreaterThanOrEqual(link.y);
        expect(centre).toBeLessThanOrEqual(link.y + link.height);
      }
      expect(await rowLink(page, word).locator("button").count(), `${word} ✕ inside the link`).toBe(0);
    }
    // The board's header and the filter's «Borrar el filtro» never share a name.
    await expect(page.getByRole("button", { name: study("filterClear") })).toHaveCount(0);

    // Tapping the ✕ never navigates.
    await deleteX(page, "leaf").click();
    await expect(page).toHaveURL((url) => url.pathname === "/registro");

    // Tapping the word does.
    await rowLink(page, "left").click();
    await expect(page).toHaveURL((url) => url.pathname === "/registro/left");
  });
}

// ------------------------------------------------------------- Confirm

test("Asking, copy on: the question promises every device and carries no local note", async ({ page }) => {
  await answerRoundsEmpty(page);
  const opened = page.waitForResponse((response) => response.url().includes("/api/log/sync"));
  await openRegistro(page, { sync: copyOn(), lookups: leaveRows() });
  await opened;
  await expect(rowLink(page, "leave")).toBeVisible();

  await deleteX(page, "leave").click();
  await expect(confirmTitle(page, "leave")).toBeVisible();
  await expect(bodyEveryDevice(page, 2)).toBeVisible();
  await expect(bodyThisDevice(page, 2)).toHaveCount(0);
  await expect(localNote(page)).toHaveCount(0);
});

// The copy is on only when enabled, with a reader on record and not retired.
// The note is true only where a reader is kept and signed out: it will delete on return.
for (const [variant, makeSync, noted] of [
  ["no account", () => undefined, false],
  ["signed in, copy never started", () => copyOn({ enabled: true, readerId: null }), false],
  ["signed out, reader kept", () => copyOn({ enabled: false }), true],
  ["retired", () => copyOn({ retired: true }), false],
] as const) {
  test(`Asking, ${variant}: the question promises this device alone, ${noted ? "and the note follows on its own muted 15 px line" : "with no note"}`, async ({
    page,
  }) => {
    await answerRoundsEmpty(page);
    await openRegistro(page, { sync: makeSync(), lookups: leaveRows() });
    await expect(rowLink(page, "leave")).toBeVisible();
    await page.waitForLoadState("networkidle");

    await deleteX(page, "leave").click();
    await expect(confirmTitle(page, "leave")).toBeVisible();
    await expect(bodyThisDevice(page, 2)).toBeVisible();
    await expect(bodyEveryDevice(page, 2), "promised every device").toHaveCount(0);
    if (!noted) {
      await expect(localNote(page)).toHaveCount(0);
      return;
    }
    await expect(localNote(page)).toBeVisible();
    const body = (await bodyThisDevice(page, 2).boundingBox())!;
    const note = (await localNote(page).boundingBox())!;
    expect(note.y, "the note sits below the body, on its own line").toBeGreaterThanOrEqual(body.y + body.height);
    expect(await localNote(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe("15px");
  });
}

test("Cancelled: «Conservar» closes the local question and nothing is deleted; another row's question closes the first", async ({
  page,
}) => {
  await openRegistro(page, { lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();

  await deleteX(page, "leave").click();
  await expect(confirmTitle(page, "leave")).toBeVisible();
  await expect(bodyThisDevice(page, 2)).toBeVisible();
  await expect(deleteX(page, "leave"), "the row's ✕ hides while its question is open").toHaveCount(0);
  await expect(page).toHaveURL((url) => url.pathname === "/registro");

  // A second row's question closes the first.
  await deleteX(page, "left").click();
  await expect(confirmTitle(page, "left")).toBeVisible();
  await expect(bodyThisDevice(page, 1)).toBeVisible();
  await expect(confirmTitle(page, "leave")).toHaveCount(0);
  await expect(deleteX(page, "leave")).toBeVisible();

  await action(page, study("deleteKeep")).click();
  await expect(confirmTitle(page, "left")).toHaveCount(0);
  await expect(localNote(page)).toHaveCount(0);
  await expect(deleteX(page, "left")).toBeVisible();
  expect(await readLookups(page), "«Conservar» deleted something").toHaveLength(4);
  await expect(header(page, 4, 3)).toBeVisible();
});

// -------------------------------------------------------------- Pending

test("Pending: a double tap on «Borrar» deletes once and shows «Borrando…» meanwhile", async ({ page }) => {
  await openRegistro(page, { lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await countDeletedEvents(page);

  // A readwrite transaction held open on `lookups` keeps the delete pending.
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

  await deleteX(page, "leave").click();
  // Two taps inside one task, before any render can intervene.
  await action(page, study("deleteConfirm")).evaluate((el) => {
    (el as HTMLElement).click();
    (el as HTMLElement).click();
  });
  await expect(page.getByText(study("deleting"), { exact: true })).toBeVisible();
  await expect(action(page, study("deleting")), "«Borrando…» still takes a tap").toBeDisabled();
  await expect(action(page, study("deleteKeep")), "«Conservar» still takes a tap").toBeDisabled();
  await expect(rowLink(page, "leave")).toBeVisible();

  await page.evaluate(() => ((window as unknown as { __release: boolean }).__release = true));
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect.poll(() => deletedEvents(page)).toBeGreaterThanOrEqual(1);
  await expect(action(page, study("deleting"))).toHaveCount(0);
  await afterFrames(page);
  expect(await deletedEvents(page), "deleteStudyGroup ran more than once").toBe(1);
});

// ----------------------------------------------------------------- Done

test("Done: the row leaves, the header drops its searches and one word, and the last row leaves the empty state", async ({
  page,
}) => {
  await openRegistro(page, { lookups: leaveRows() });
  await expect(header(page, 4, 3)).toBeVisible();

  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(header(page, 2, 2)).toBeVisible();
  await expect(page.getByText(study("deleting"), { exact: true })).toHaveCount(0);

  await deleteViaUi(page, "leaf");
  await expect(header(page, 1, 1)).toBeVisible();

  await deleteViaUi(page, "left");
  await expect(page.getByText(study("emptyTitle"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: study("emptyAction") })).toBeVisible();
  expect(await readLookups(page)).toHaveLength(0);
});

// --------------------------------------------------------------- Failed

test("Failed: an aborted transaction leaves the row and says so; «Conservar» closes the block; «Reintentar» deletes without a second question", async ({
  page,
}) => {
  await answerRoundsEmpty(page);
  await openRegistro(page, { sync: copyOn({ enabled: false }), lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await page.waitForLoadState("networkidle");

  // The commit is refused: every delete is followed by an abort.
  await page.evaluate(() => {
    const w = window as unknown as { __failDelete: boolean };
    w.__failDelete = true;
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      if (w.__failDelete) this.transaction.abort();
      return result;
    };
  });

  const failure = page.getByRole("alert").filter({ hasText: study("deleteFailedTitle", { word: "leave" }) });
  // Signed out with its reader: the question carries the note, the failure block never does.
  await deleteX(page, "leave").click();
  await expect(localNote(page)).toBeVisible();
  await action(page, study("deleteConfirm")).click();
  await expect(failure).toBeVisible();
  await expect(page.getByText(study("deleteFailedBody", { count: 2 }), { exact: true })).toBeVisible();
  await expect(localNote(page), "the note followed into the failure").toHaveCount(0);
  await expect(bodyThisDevice(page, 2)).toHaveCount(0);
  await expect(rowLink(page, "leave"), "the row never left").toBeVisible();
  await expect(header(page, 4, 3)).toBeVisible();
  expect(await readLookups(page)).toHaveLength(4);

  // «Conservar» closes the block and returns the ✕.
  await action(page, study("deleteKeep")).click();
  await expect(failure).toHaveCount(0);
  await expect(deleteX(page, "leave")).toBeVisible();

  // Second try, fails again; the cause is gone before the retry.
  await deleteViaUi(page, "leave");
  await expect(failure).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __failDelete: boolean }).__failDelete = false));
  await action(page, messages.log.retry).click();
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(confirmTitle(page, "leave"), "retry asked a second question").toHaveCount(0);
  await expect(failure).toHaveCount(0);
  await expect(header(page, 2, 2)).toBeVisible();
  expect(shape(await readLookups(page))).toEqual(["leave>leaf", "left>left"]);
});

// ------------------------------------------------------------ Only its group

for (const [deleted, kept, remaining] of [
  ["leave", ["left", "leaf"], ["left>left", "leave>leaf"]],
  ["left", ["leave", "leaf"], ["leave>leaf", "leave>leave", "left>leave"]],
] as const) {
  test(`Only its group: deleting «${deleted}» takes that row's searches and no other`, async ({ page }) => {
    await openRegistro(page, { lookups: leaveRows() });
    await expect(rowLink(page, deleted)).toBeVisible();
    await deleteViaUi(page, deleted);
    await expect(rowLink(page, deleted)).toHaveCount(0);
    for (const word of kept) await expect(rowLink(page, word)).toBeVisible();
    expect(shape(await readLookups(page))).toEqual([...remaining].sort());
  });
}

// ------------------------------------------------------------- Filtered

test("Filtered: deleting while filtering keeps the filter and updates «N de M»", async ({ page }) => {
  await openRegistro(page, { lookups: leaveRows() });
  const filter = page.getByRole("textbox", { name: study("filterLabel") });
  await filter.fill("lea");
  await expect(page.getByText(study("filterCount", { shown: 2, total: 3 }), { exact: true })).toBeVisible();
  await expect(rowLink(page, "left")).toHaveCount(0);

  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(filter).toHaveValue("lea");
  await expect(page).toHaveURL(/filtro=lea/);
  await expect(page.getByText(study("filterCount", { shown: 1, total: 2 }), { exact: true })).toBeVisible();
  await expect(rowLink(page, "leaf")).toBeVisible();
  await expect(rowLink(page, "left"), "the filter was reset").toHaveCount(0);
});

// ------------------------------------------------- A delete's own round

test("RNL-11, copy on: a delete starts exactly one round of its own, with no hide, carrying the group's marks once", async ({
  page,
}) => {
  const sync = copyOn();
  await answerRoundsEmpty(page);
  const rounds = trackRounds(page);
  await openRegistro(page, { sync, lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await expect.poll(rounds.count).toBe(1);
  await page.waitForLoadState("networkidle");
  const before = rounds.count();
  const ids = await groupIds(page, "leave");
  expect(ids).toHaveLength(2);

  await freezeTimers(page);
  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect.poll(rounds.count, { message: "the delete started no round", timeout: 3_000 }).toBeGreaterThan(before);
  // Five seconds of the page's own time: a second round, had one been owed, has left.
  await runClock(page, 5_000);
  expect(rounds.count(), "one delete, one round").toBe(before + 1);
  const own = rounds.bodies[before];
  expect(own.tombstones.map((mark) => mark.localId).sort()).toEqual(ids);
  expect(new Set(own.tombstones.map((mark) => mark.deviceId))).toEqual(new Set([sync.deviceId]));

  // Sent once: the next trigger, a fresh open, carries none.
  const settled = rounds.count();
  await page.clock.resume();
  await page.goto("/registro");
  await expect.poll(rounds.count).toBeGreaterThan(settled);
  await page.waitForLoadState("networkidle");
  expect(rounds.bodies.at(-1)!.tombstones, "marks sent twice").toEqual([]);
});

test("RNL-11, one round per delete: two deletes add at most three rounds, every mark leaves once, and the next round carries none", async ({
  page,
}) => {
  await answerRoundsEmpty(page);
  const rounds = trackRounds(page);
  await openRegistro(page, { sync: copyOn(), lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await expect.poll(rounds.count).toBe(1);
  await page.waitForLoadState("networkidle");
  const before = rounds.count();
  const ids = [...(await groupIds(page, "leave")), ...(await groupIds(page, "leaf"))].sort();
  expect(ids).toHaveLength(3);

  await freezeTimers(page);
  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await deleteViaUi(page, "leaf");
  await expect(rowLink(page, "leaf")).toHaveCount(0);
  // The page's clock moves in small steps while the marks are awaited: a round that
  // queues behind the one in flight is started by a timer.
  await expect
    .poll(
      async () => {
        await runClock(page, 250);
        return sentMarks(rounds.bodies);
      },
      { message: "the marks never left", timeout: 3_000 },
    )
    .toEqual(ids);
  await runClock(page, 5_000);
  expect(rounds.count() - before, "rounds per delete").toBeLessThanOrEqual(2 + 1);
  expect(sentMarks(rounds.bodies), "a mark sent twice").toEqual(ids);

  const settled = rounds.count();
  await page.clock.resume();
  await page.goto("/registro");
  await expect.poll(rounds.count).toBeGreaterThan(settled);
  await page.waitForLoadState("networkidle");
  expect(rounds.bodies.at(-1)!.tombstones, "marks sent twice").toEqual([]);
});

test("RNL-11, a round in flight: a delete made while the open round is held leaves in a round after it, with no hide", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route("**/api/log/sync", async (route) => {
    if (held++ === 0) await gate;
    await answerJson(route, emptyRound);
  });
  const rounds = trackRounds(page);
  await openRegistro(page, { sync: copyOn(), lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await expect.poll(rounds.count, { message: "the open round never left" }).toBe(1);
  expect(rounds.bodies[0].tombstones).toEqual([]);
  const ids = await groupIds(page, "leave");

  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  release();
  await expect
    .poll(() => sentMarks(rounds.bodies), { message: "the marks waited for a hide", timeout: 3_000 })
    .toEqual(ids);
  expect(rounds.bodies.slice(1).some((body) => body.tombstones.length === 2)).toBe(true);
});

// ----------------------------------------------------------- No account

for (const [variant, makeSync] of [
  ["no account", () => undefined],
  ["signed out", () => copyOn({ enabled: false })],
] as const) {
  test(`Copy off, ${variant}: the row leaves and no request leaves the device`, async ({ page }) => {
    await answerRoundsEmpty(page);
    const api = apiRequests(page);
    await openRegistro(page, { sync: makeSync(), lookups: leaveRows() });
    await expect(rowLink(page, "leave")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const before = api.length;

    await freezeTimers(page);
    await deleteViaUi(page, "leave");
    await expect(rowLink(page, "leave")).toHaveCount(0);
    await runClock(page, 5_000);
    expect(api.slice(before), "a delete with the copy off sent a request").toEqual([]);
    expect(shape(await readLookups(page))).toEqual(["leave>leaf", "left>left"]);
    if (variant === "no account") expect(await syncKeys(page)).not.toContain("tombstones");
    // Signed out keeps the reader: the marks wait for the next sign-in.
    else expect(await syncKeys(page)).toContain("tombstones");
  });
}

// -------------------------------------------------------------- Offline

test("Offline: the row leaves with no network and the next round online carries its marks", async ({ page, context }) => {
  const sync = copyOn();
  let offline = false;
  // A routed request never meets the context's offline switch: the handler is the network.
  await page.route("**/api/log/sync", (route) =>
    offline ? route.abort("internetdisconnected") : answerJson(route, emptyRound),
  );
  const rounds = trackRounds(page);
  await openRegistro(page, { sync, lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();
  await expect.poll(rounds.count).toBe(1);
  await page.waitForLoadState("networkidle");
  const ids = (await readLookups(page)).filter((row) => (row.headword ?? row.normalised) === "leave").map((row) => row.id);

  offline = true;
  await context.setOffline(true);
  // The delete's own round, with no hide, fails offline and must keep the marks.
  const failedRound = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().includes("/api/log/sync"),
    timeout: 3_000,
  });
  await deleteViaUi(page, "leave");
  await expect(rowLink(page, "leave")).toHaveCount(0);
  await expect(page.getByText(study("deleteFailedTitle", { word: "leave" }))).toHaveCount(0);
  await failedRound;

  offline = false;
  await context.setOffline(false);
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/log/sync") &&
      (response.request().postDataJSON() as { tombstones: Mark[] }).tombstones.length > 0,
    { timeout: 15_000 },
  );
  await page.goto("/registro");
  const body = (await answered).request().postDataJSON() as { tombstones: Mark[] };
  expect(body.tombstones.map((mark) => mark.localId).sort()).toEqual([...ids].sort());
});

// ------------------------------------------------- The word page afterwards

test("The word page after: /registro/<word> draws the never-searched state", async ({ page }) => {
  await openRegistro(page, { lookups: [lookup("zebra"), lookup("zebra"), lookup("apple")] });
  await expect(rowLink(page, "zebra")).toBeVisible();
  await deleteViaUi(page, "zebra");
  await expect(rowLink(page, "zebra")).toHaveCount(0);

  await page.goto("/registro/zebra");
  await expect(page.getByText(messages.log.word.emptyBody.replace("{word}", "zebra"))).toBeVisible();
  await expect(page.getByRole("button", { name: messages.log.word.emptyAction })).toBeVisible();
});

// ------------------------------------------------------ Every device (RL-70)

async function mintReader(sql: postgres.Sql, runId: string): Promise<{ id: string; email: string; hash: string }> {
  const id = randomUUID();
  const email = `harness-reader-${id}@example.invalid`;
  await sql.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });
  return { id, email, hash: await mintToken(sql, id, email) };
}

// One token per user at a time: mint the second device's after the first was spent.
async function mintToken(sql: postgres.Sql, id: string, email: string): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  await sql`
    update auth.users set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${id}`;
  await sql`delete from auth.one_time_tokens where user_id = ${id}`;
  await sql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values (${randomUUID()}, ${id}, 'recovery_token', ${hash}, ${email}, now(), now())`;
  return hash;
}

async function signInAs(page: Page, hash: string): Promise<void> {
  const response = await page.request.get(`/auth/confirm?token_hash=${hash}&type=magiclink`, { maxRedirects: 0 });
  const location = response.headers()["location"];
  expect(location?.includes("error="), `redirected to ${location ?? "nowhere"}`).toBe(false);
}

test("RL-70: a delete on one device leaves every device of the reader, and no later round brings it back", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const runId = await openRun("e2e", sql);
  const reader = await mintReader(sql, runId);
  const contextB = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const pageB = await contextB.newPage();
  const isSync = (response: { url(): string }) => response.url().includes("/api/log/sync");

  try {
    // Device A records `zebra` twice and `apple` once, and copies them.
    await deleteTranslator(page);
    await signInAs(page, reader.hash);
    await seed(page, {
      sync: copyOn({ readerId: reader.id }),
      lookups: [lookup("zebra"), lookup("zebra"), lookup("apple")],
    });
    const uploaded = page.waitForResponse(isSync);
    await page.goto("/registro");
    expect((await uploaded).status()).toBe(200);
    await expect(rowLink(page, "zebra")).toBeVisible();

    // Device B joins the same reader and pulls them.
    await deleteTranslator(pageB);
    await signInAs(pageB, await mintToken(sql, reader.id, reader.email));
    await seed(pageB, { sync: copyOn({ readerId: reader.id }) });
    await pageB.goto("/registro");
    await expect(rowLink(pageB, "zebra"), "device B never received the word").toBeVisible({ timeout: 20_000 });

    // A deletes `zebra`; the delete's own round sends the marks, with no hide.
    const sent = page.waitForResponse(
      (response) =>
        isSync(response) && (response.request().postDataJSON() as { tombstones: Mark[] }).tombstones.length === 2,
      { timeout: 5_000 },
    );
    await deleteViaUi(page, "zebra");
    await expect(rowLink(page, "zebra")).toHaveCount(0);
    expect((await sent).status()).toBe(200);

    // B opens /registro again: a round, and `zebra` is gone from list and store.
    const pulled = pageB.waitForResponse(isSync);
    await pageB.goto("/registro");
    expect((await pulled).status()).toBe(200);
    await expect(rowLink(pageB, "apple")).toBeVisible();
    await expect(rowLink(pageB, "zebra")).toHaveCount(0);
    expect((await readLookups(pageB)).filter((row) => row.normalised === "zebra")).toHaveLength(0);

    // B's later round does not bring it back to A.
    const later = pageB.waitForResponse(isSync);
    await hideTab(pageB);
    expect((await later).status()).toBe(200);
    const reopened = page.waitForResponse(isSync);
    await page.goto("/registro");
    await reopened;
    await expect(rowLink(page, "apple")).toBeVisible();
    await expect(rowLink(page, "zebra")).toHaveCount(0);
    expect((await readLookups(page)).filter((row) => row.normalised === "zebra")).toHaveLength(0);
  } finally {
    await contextB.close();
    await sql`delete from harness.identities where user_id = ${reader.id}`;
    await sql`delete from auth.users where id = ${reader.id}`;
    await closeRun(sql);
    await sql.end();
  }
});

// ----------------------------------------------- Deleting holds both controls

test("Deleting: while the delete is held, «Conservar» and «Borrar» are both disabled", async ({ page }) => {
  await openRegistro(page, { lookups: leaveRows() });
  await expect(rowLink(page, "leave")).toBeVisible();

  // A readwrite transaction kept alive on `lookups` holds the delete pending.
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

  await deleteX(page, "leave").click();
  await action(page, study("deleteConfirm")).click();
  // While held, «Borrar» reads «Borrando…»: that is the same button.
  await expect(action(page, study("deleting"))).toBeDisabled();
  await expect(action(page, study("deleteKeep"))).toBeDisabled();
  await expect(action(page, study("deleteConfirm")), "«Borrar» is still offered while deleting").toHaveCount(0);

  await page.evaluate(() => ((window as unknown as { __release: boolean }).__release = true));
  await expect(rowLink(page, "leave")).toHaveCount(0);
});
