import { expect, freezeTimers, pageTasks, runClock, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import { PHRASE_DEBOUNCE_MS } from "../lib/query/settle";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the mount effect must never reach it in this suite.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
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

const TEXT = {
  definition: null,
  example: { en: "She opened her umbrella as it started to rain.", es: "Abrió su paraguas cuando empezó a llover." },
};

const UNLISTED = {
  translations: ["coccidiosis"],
  definition: "A parasitic disease of the intestine.",
  example: { en: "The flock was tested for coccidiosis.", es: "Se examinó a la parvada por coccidiosis." },
  lemma: null,
  rule: null,
};

// The words each request to `endpoint` asked about, in the order they left.
function track(page: Page, endpoint: string, field: "headword" | "word"): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (!request.url().includes(endpoint)) return;
    asked.push((request.postDataJSON() as Record<string, string>)[field]);
  });
  return asked;
}

async function lookUp(page: Page, word: string): Promise<void> {
  await page.getByRole("textbox", { name: messages.search.label }).fill(word);
}

// Past one debounce window on a frozen clock: a request the screen was going
// to send has left, and the screen has drawn what came back.
async function settle(page: Page): Promise<void> {
  await runClock(page, PHRASE_DEBOUNCE_MS);
}

test("pending: the decoration's line shows while the text request is held open", async ({
  page,
  scriptWordRoute,
  releaseWordRoute,
}) => {
  await deleteTranslator(page);
  await scriptWordRoute("text", [{ kind: "hold" }]);
  await openReady(page);

  await lookUp(page, "umbrella");
  await expect(page.getByText(messages.word.definitionGenerating)).toBeVisible();

  await releaseWordRoute("text");
  await expect(page.getByText(messages.word.definitionGenerating)).toHaveCount(0);
});

test("an aborted text request is asked again the next time the word is looked up", async ({
  page,
  scriptWordRoute,
}) => {
  await deleteTranslator(page);
  await scriptWordRoute("text", [{ kind: "abort" }, { kind: "status", status: 204 }, { kind: "ok", body: TEXT }]);
  const asked = track(page, "/api/word/text", "headword");
  await openReady(page);

  const aborted = page.waitForEvent("requestfailed", (request) => request.url().includes("/api/word/text"));
  await lookUp(page, "umbrella");
  await aborted;
  await pageTasks(page);
  await expect.poll(() => asked.filter((w) => w === "umbrella").length).toBe(1);
  await expect(page.getByText(TEXT.example.en)).toHaveCount(0);

  await lookUp(page, "apple");
  await expect.poll(() => asked.filter((w) => w === "apple").length).toBe(1);
  await lookUp(page, "umbrella");

  await expect.poll(() => asked.filter((w) => w === "umbrella").length).toBe(2);
  await expect(page.getByText(TEXT.example.en)).toBeVisible();
});

test("a 503 is asked again: first 503, then 200, and the example draws", async ({ page, scriptWordRoute }) => {
  await deleteTranslator(page);
  await scriptWordRoute("text", [{ kind: "status", status: 503 }, { kind: "status", status: 204 }, { kind: "ok", body: TEXT }]);
  const asked = track(page, "/api/word/text", "headword");
  await openReady(page);

  const refused = page.waitForResponse((response) => response.url().includes("/api/word/text"));
  await lookUp(page, "umbrella");
  await refused;
  await pageTasks(page);
  await expect.poll(() => asked.filter((w) => w === "umbrella").length).toBe(1);
  await expect(page.getByText(TEXT.example.en)).toHaveCount(0);

  await lookUp(page, "apple");
  await expect.poll(() => asked.filter((w) => w === "apple").length).toBe(1);
  await lookUp(page, "umbrella");

  await expect.poll(() => asked.filter((w) => w === "umbrella").length).toBe(2);
  await expect(page.getByText(TEXT.example.en)).toBeVisible();
});

test("a 204 is not asked again: umbrella, apple, umbrella costs one request for umbrella", async ({ page }) => {
  await deleteTranslator(page);
  const asked = track(page, "/api/word/text", "headword");
  await openReady(page);

  await lookUp(page, "umbrella");
  await expect.poll(() => asked.filter((w) => w === "umbrella").length).toBe(1);
  await lookUp(page, "apple");
  await expect.poll(() => asked.filter((w) => w === "apple").length).toBe(1);
  await freezeTimers(page);
  await lookUp(page, "umbrella");
  await settle(page);

  expect(asked.filter((w) => w === "umbrella")).toHaveLength(1);
});

test("a 200 is not asked again: umbrella, apple, umbrella costs one request for umbrella", async ({
  page,
  stubWordText,
}) => {
  await deleteTranslator(page);
  await stubWordText(TEXT);
  const asked = track(page, "/api/word/text", "headword");
  await openReady(page);

  await lookUp(page, "umbrella");
  await expect(page.getByText(TEXT.example.en)).toBeVisible();
  await lookUp(page, "apple");
  await expect.poll(() => asked.filter((w) => w === "apple").length).toBe(1);
  await freezeTimers(page);
  await lookUp(page, "umbrella");
  await expect(page.getByText(TEXT.example.en)).toBeVisible();
  await settle(page);

  expect(asked.filter((w) => w === "umbrella")).toHaveLength(1);
});

test("an unlisted word whose request was aborted is asked again after another word", async ({
  page,
  scriptWordRoute,
}) => {
  await deleteTranslator(page);
  await scriptWordRoute("unlisted", [{ kind: "abort" }, { kind: "ok", body: UNLISTED }]);
  const asked = track(page, "/api/word/unlisted", "word");
  await openReady(page);

  await lookUp(page, "coccidiosis");
  await expect.poll(() => asked.filter((w) => w === "coccidiosis").length).toBe(1);
  await expect(page.getByText(messages.word.networkFailed)).toBeVisible();

  await lookUp(page, "apple");
  await expect(page.getByRole("heading", { name: "apple", exact: true })).toBeVisible();
  await lookUp(page, "coccidiosis");

  await expect.poll(() => asked.filter((w) => w === "coccidiosis").length).toBe(2);
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible();
  await expect(page.getByText(UNLISTED.example.en)).toBeVisible();
});
