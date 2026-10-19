import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// RL-76: a lookup the device could not answer is kept as a pending row (a
// schema-4 `miss` word or `untranslated` sentence), only when it would have
// been asked had the device been online; and the app answers it when the
// network returns, on load and on the `online` event.

const UNLISTED = "/api/word/unlisted";
const TRANSLATE = "/api/translate";

const BODY = {
  translations: ["¿en dónde?", "adónde"],
  definition: "At what place.",
  example: { en: "Whereat did he look?", es: "¿Hacia dónde miró?" },
  lemma: null,
  rule: null,
};

type Row = {
  id: number;
  schema: number;
  at: number;
  text: string;
  normalised: string;
  kind: string;
  outcome: string;
  translation: string | null;
  origin: string | null;
  askedOn?: string | null;
};

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// `context.setOffline` stops the network, but a fulfilling route still answers
// it: while `offline` holds, the paid routes fail the way a dead signal does.
async function failWhileOffline(page: Page): Promise<{ goOffline(): void; goOnline(): void }> {
  let offline = false;
  for (const path of [UNLISTED, TRANSLATE]) {
    await page.route(`**${path}`, (route) => (offline ? route.abort("internetdisconnected") : route.fallback()));
  }
  return { goOffline: () => (offline = true), goOnline: () => (offline = false) };
}

async function openReady(page: Page): Promise<Locator> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
  const box = page.getByRole("textbox", { name: messages.search.label });
  await expect(box).toBeVisible();
  return box;
}

async function readLogRows(page: Page): Promise<Row[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const getAll = db.transaction("lookups", "readonly").objectStore("lookups").getAll();
          getAll.onsuccess = () => {
            db.close();
            resolve(getAll.result);
          };
          getAll.onerror = () => reject(getAll.error);
        };
      }),
  );
}

async function rowsFor(page: Page, normalised: string, count: number): Promise<Row[]> {
  await expect
    .poll(async () => (await readLogRows(page)).filter((row) => row.normalised === normalised).length, {
      message: `rows for "${normalised}"`,
    })
    .toBe(count);
  return (await readLogRows(page)).filter((row) => row.normalised === normalised);
}

// A hit recorded after an earlier lookup cannot land before it: once this row
// is on disk, every earlier settle has written its row or declined to. The
// only way to prove an absence without sleeping.
async function afterSentinel(page: Page, box: Locator): Promise<void> {
  await box.fill("apple");
  await expect(page.getByRole("heading", { name: "apple" })).toBeVisible();
  await box.fill("");
  await rowsFor(page, "apple", 1);
}

test("offline, a word the dictionary lacks is kept as one pending schema-4 miss", async ({ page, context }) => {
  await deleteTranslator(page);
  const network = await failWhileOffline(page);
  const box = await openReady(page);
  network.goOffline();
  await context.setOffline(true);

  await box.fill("whereat");
  await expect(page.getByText(messages.search.notFound).first()).toBeVisible();
  await box.fill("");

  const rows = await rowsFor(page, "whereat", 1);
  expect(rows[0]).toMatchObject({
    schema: 4,
    kind: "word",
    outcome: "miss",
    text: "whereat",
    translation: null,
  });
  expect(rows[0].askedOn ?? null).toBeNull();
});

test("a prefix that stands in suggestions leaves no row, even though nothing answered it", async ({ page }) => {
  await deleteTranslator(page);
  const box = await openReady(page);

  await box.fill("ru");
  await expect(page.getByText(messages.word.suggestions)).toBeVisible();
  // Let the effects that hand the settled lookup to the log run before the box moves on.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await box.fill("");
  await afterSentinel(page, box);

  expect((await readLogRows(page)).filter((row) => row.normalised === "ru")).toHaveLength(0);
});

test("offline, a sentence in range is kept as one pending untranslated phrase, never a miss", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  const network = await failWhileOffline(page);
  const box = await openReady(page);
  network.goOffline();
  await context.setOffline(true);

  const sentence = "the cat sits still";
  await box.fill(sentence);
  await expect(page.locator("main").getByRole("heading", { name: "cat" })).toBeVisible();
  await box.fill("");

  const rows = await rowsFor(page, sentence, 1);
  expect(rows[0]).toMatchObject({
    schema: 4,
    kind: "phrase",
    outcome: "untranslated",
    text: sentence,
    translation: null,
    origin: null,
  });
});

test("a sentence of 61 words leaves no row", async ({ page }) => {
  await deleteTranslator(page);
  // The model route is never reached by a string past the ceiling; answered anyway, never the model.
  await page.route(`**${TRANSLATE}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "x", origin: "network" }) }),
  );
  const box = await openReady(page);

  const tokens = 61;
  await box.fill(Array.from({ length: tokens }, () => "dog").join(" "));
  await expect(page.getByText(messages.search.noEntry.tooLong.replace("{count}", String(tokens)))).toBeVisible();
  await box.fill("");
  await afterSentinel(page, box);

  expect((await readLogRows(page)).filter((row) => row.kind === "phrase")).toHaveLength(0);
});

test("back online, the app answers the pending word it holds: the row becomes unlisted with its translation", async ({
  page,
  context,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  const network = await failWhileOffline(page);
  const box = await openReady(page);
  network.goOffline();
  await context.setOffline(true);

  await box.fill("whereat");
  await expect(page.getByText(messages.search.notFound).first()).toBeVisible();
  await box.fill("");
  const [waiting] = await rowsFor(page, "whereat", 1);
  expect(waiting.outcome).toBe("miss");

  network.goOnline();
  await context.setOffline(false);

  await expect
    .poll(async () => (await readLogRows(page)).filter((row) => row.normalised === "whereat").map((row) => row.outcome))
    .toEqual(["unlisted"]);
  const [answered] = await rowsFor(page, "whereat", 1);
  expect(answered).toMatchObject({ kind: "word", at: waiting.at, translation: "¿en dónde?, adónde" });
  expect(answered.id).toBeGreaterThan(waiting.id);
});

test("opening the app online answers the pending word it holds, once", async ({
  page,
  scriptWordRoute,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(BODY);
  // The screen's own ask gets nothing, leaving the word waiting; the next ask is answered.
  await scriptWordRoute("unlisted", [{ kind: "status", status: 204 }]);
  const box = await openReady(page);

  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === UNLISTED);
  await box.fill("whereat");
  expect((await answered).status()).toBe(204);
  await box.fill("");
  const [waiting] = await rowsFor(page, "whereat", 1);
  expect(waiting).toMatchObject({ schema: 4, outcome: "miss" });

  let asks = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === UNLISTED) asks += 1;
  });
  await page.reload();

  await expect
    .poll(async () => (await readLogRows(page)).filter((row) => row.normalised === "whereat").map((row) => row.outcome))
    .toEqual(["unlisted"]);
  const [replaced] = await rowsFor(page, "whereat", 1);
  expect(replaced).toMatchObject({ at: waiting.at, translation: "¿en dónde?, adónde" });
  expect(asks).toBe(1);
});
