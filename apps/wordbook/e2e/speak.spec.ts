import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the mount effect must never reach it in this suite.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// Records every `speechSynthesis.speak()`/`.cancel()` call by patching the
// prototype rather than the `window.speechSynthesis` instance property,
// which Chromium exposes as accessor-only and silently refuses to
// overwrite. Nothing in CI has an audio device, so no utterance ever runs.
async function captureSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: { text: string; lang: string }[] = [];
    let cancelCount = 0;
    (window as unknown as { __speakCalls: typeof calls }).__speakCalls = calls;
    (window as unknown as { __cancelCount: () => number }).__cancelCount = () => cancelCount;
    const proto = window.SpeechSynthesis.prototype;
    proto.speak = function (utterance: SpeechSynthesisUtterance) {
      calls.push({ text: utterance.text, lang: utterance.lang });
    };
    proto.cancel = function () {
      cancelCount += 1;
    };
  });
}

async function deleteSpeechSynthesis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  });
}

// `useDecoration`'s own debounce (`PHRASE_DEBOUNCE_MS`) plus margin: long
// enough that its pair of requests has fired by the time this elapses.
const DECORATION_SETTLE_MARGIN_MS = 900;

async function gotoReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  // The fetch settling is not the worker posting "ready": buildIndex still
  // has to run over 64,258 entries. Give it room before the box is used.
  await page.waitForTimeout(1000);
}

test("RL-26: a headword with IPA can be heard, in the browser's own voice", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });

  const speakButton = page.getByRole("button", { name: "Escuchar «throughout»" });
  await expect(speakButton).toBeVisible();

  const box = await speakButton.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(44);
  expect(Math.round(box!.height)).toBe(44);

  await speakButton.click();
  const calls = await page.evaluate(() => (window as unknown as { __speakCalls: { text: string; lang: string }[] }).__speakCalls);
  expect(calls).toEqual([{ text: "throughout", lang: "en-US" }]);
});

test("RL-26: a headword with no IPA is heard exactly like one that has it", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  // FreeDict carries no IPA for "abandonable" (36,320 of 64,258 entries do;
  // this one is among the 27,938 that do not).
  await searchBox.fill("abandonable");
  await expect(page.getByRole("heading", { name: "abandonable" })).toBeVisible({ timeout: 5000 });

  const speakButton = page.getByRole("button", { name: "Escuchar «abandonable»" });
  await expect(speakButton).toBeVisible();

  await speakButton.click();
  const calls = await page.evaluate(() => (window as unknown as { __speakCalls: { text: string; lang: string }[] }).__speakCalls);
  expect(calls).toEqual([{ text: "abandonable", lang: "en-US" }]);
});

test("RL-26: a second press restarts the word rather than queueing behind it", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  const speakButton = page.getByRole("button", { name: "Escuchar «throughout»" });
  await expect(speakButton).toBeVisible();

  await speakButton.click();
  await speakButton.click();

  const cancelCount = await page.evaluate(() => (window as unknown as { __cancelCount: () => number }).__cancelCount());
  const calls = await page.evaluate(() => (window as unknown as { __speakCalls: unknown[] }).__speakCalls);
  // Every speak() is preceded by a cancel() of whatever was already in
  // flight, so two presses never sound as two overlapping utterances.
  expect(cancelCount).toBe(2);
  expect(calls).toHaveLength(2);
});

test("RL-26: with no speechSynthesis, the control does not render at all", async ({ page }) => {
  await deleteTranslator(page);
  await deleteSpeechSynthesis(page);
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });

  await expect(page.getByRole("button", { name: "Escuchar «throughout»" })).toHaveCount(0);
});

test("RL-26: pressing the speak control fires no network request of its own", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  // Warms whatever the headword's own type first costs to load (a font
  // subset, fetched once per weight the page has not yet drawn) so the
  // count below isolates typing and speaking, not that one-time cost.
  await searchBox.fill("throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(300);

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await searchBox.fill("");
  await searchBox.fill("abandonable");
  await expect(page.getByRole("heading", { name: "abandonable" })).toBeVisible({ timeout: 5000 });

  // The stricter bound: at the instant of paint, decoration's own debounce
  // has not fired yet, so the click below still finds nothing pending.
  const atPaint = requests.filter((url) => !url.includes(manifest.asset.path));
  expect(atPaint, `requests before decoration could fire: ${JSON.stringify(atPaint)}`).toEqual([]);

  // The assertion this test exists for, kept intact: the click itself emits
  // nothing of its own.
  const speakButton = page.getByRole("button", { name: "Escuchar «abandonable»" });
  await speakButton.click();
  await page.waitForTimeout(DECORATION_SETTLE_MARGIN_MS);

  const stray = requests.filter((url) => !url.includes(manifest.asset.path) && !url.includes("/api/word/"));
  expect(stray, `requests foreign to decoration: ${JSON.stringify(stray)}`).toEqual([]);

  // One settled word, never one request per keystroke or per click.
  const decoration = requests.filter((url) => url.includes("/api/word/"));
  expect(decoration.length, "decoration never asked").toBeGreaterThanOrEqual(1);
  expect(decoration.length).toBeLessThanOrEqual(2);
});

test("RL-26 at 360px, dark: 44px tap target, muted glyph #9a9484", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  const speakButton = page.getByRole("button", { name: "Escuchar «throughout»" });
  await expect(speakButton).toBeVisible();

  const box = await speakButton.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(44);
  expect(Math.round(box!.height)).toBe(44);

  const colour = await speakButton.evaluate((el) => getComputedStyle(el).color);
  expect(colour).toBe("rgb(154, 148, 132)");
});

test("RL-26 at 1280px, light: 44px tap target, muted glyph #6b675a", async ({ page }) => {
  await deleteTranslator(page);
  await captureSpeech(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await gotoReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("throughout");
  const speakButton = page.getByRole("button", { name: "Escuchar «throughout»" });
  await expect(speakButton).toBeVisible();

  const box = await speakButton.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.width)).toBe(44);
  expect(Math.round(box!.height)).toBe(44);

  const colour = await speakButton.evaluate((el) => getComputedStyle(el).color);
  expect(colour).toBe("rgb(107, 103, 90)");
});
