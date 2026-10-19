import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

const PHRASE_DEBOUNCE_MS = 600;

const FIRST = { source: "black minorca pullets", translation: "pollitas negras de menorca" };
const SECOND = { source: "grey goose feathers", translation: "plumas de ganso gris" };
const NOTES = { notes: [{ term: "black minorca", note: "Es una raza de gallina de color negro." }] };

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); deleting it sends every sentence over the network.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function stubTranslate(page: Page): Promise<void> {
  const answers: Record<string, string> = {
    [FIRST.source]: FIRST.translation,
    [SECOND.source]: SECOND.translation,
  };
  await page.route("**/api/translate", async (route) => {
    const { text } = route.request().postDataJSON() as { text: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: answers[text], origin: "network" }),
    });
  });
}

async function openReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
}

function trackNotes(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/phrase/notes")) return;
    asked.push((request.postDataJSON() as { source: string }).source);
  });
  return asked;
}

async function lookUp(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: messages.search.label }).fill(text);
}

test("pending: the notes line shows while the notes request is held open", async ({
  page,
  scriptWordRoute,
  releaseWordRoute,
}) => {
  await deleteTranslator(page);
  await stubTranslate(page);
  await scriptWordRoute("notes", [{ kind: "hold" }]);
  await openReady(page);

  await lookUp(page, FIRST.source);
  await expect(page.getByText(FIRST.translation)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.phrase.notesPending)).toBeVisible();

  await releaseWordRoute("notes");
  await expect(page.getByText(messages.phrase.notesPending)).toHaveCount(0);
});

test("notes whose request was refused by the network are asked again on the next look", async ({
  page,
  scriptWordRoute,
}) => {
  await deleteTranslator(page);
  await stubTranslate(page);
  await scriptWordRoute("notes", [{ kind: "abort" }, { kind: "status", status: 204 }, { kind: "ok", body: NOTES }]);
  const asked = trackNotes(page);
  await openReady(page);

  await lookUp(page, FIRST.source);
  await expect.poll(() => asked.filter((s) => s === FIRST.source).length).toBe(1);
  await expect(page.getByText(FIRST.translation)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(NOTES.notes[0].note)).toHaveCount(0);

  await lookUp(page, SECOND.source);
  await expect.poll(() => asked.filter((s) => s === SECOND.source).length, { timeout: PHRASE_DEBOUNCE_MS + 5000 }).toBe(1);
  await lookUp(page, FIRST.source);

  await expect.poll(() => asked.filter((s) => s === FIRST.source).length, { timeout: PHRASE_DEBOUNCE_MS + 5000 }).toBe(2);
  await expect(page.getByText(NOTES.notes[0].note)).toBeVisible();
});
