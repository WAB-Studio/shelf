import { expect, pageTasks, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// RL-45: the network's own translations for a thin dictionary answer draw
// under the dictionary's, never inside it — this is the module 8 done
// criterion, proved against `snuff`, the thin entry the text route is asked about.

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the word path here must never reach it.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// `manifest.asset.path` is only ever fetched once per browser context; a
// second `loadSnuff` in the same test hits the cache and gives no fresh
// `response` event for `waitForResponse` to catch, so this waits for the
// heading itself, generously, instead of for the asset (`palabra-historial
// .spec.ts`'s own `/?q=snuff` navigation follows the same pattern).
async function loadSnuff(page: Page): Promise<void> {
  const decorated = page.waitForResponse((response) => response.url().includes("/api/word/text"));
  await page.goto("/?q=snuff");
  await expect(page.getByRole("heading", { name: "snuff", exact: true })).toBeVisible({ timeout: 10000 });
  await decorated;
  await pageTasks(page);
}

// Everything the page drew before `GeneratedText`'s own block — the
// headword row and `SenseGroup`'s senses, translations and IPA — read as one
// string with a DOM `Range` rather than a component boundary, since no file
// this module may touch owns a selector for "the dictionary's block" on its
// own.
async function textBeforeGeneratedBlock(page: Page): Promise<string> {
  return page.evaluate(() => {
    const marker = document.querySelector("[data-generated-block]");
    if (!marker) return document.body.textContent ?? "";
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(marker);
    return range.toString();
  });
}

async function stubThinWordText(
  stubWordText: (body: { definition: string | null; translations?: string[] | null }) => Promise<void>,
  body: { definition: string | null; translations: string[] | null },
): Promise<void> {
  await stubWordText(body);
}

test("snuff's dictionary senses draw unchanged whether the network's translations arrive or not, and the network's own lines sit marked underneath them", async ({
  page,
  stubWordText,
}) => {
  await deleteTranslator(page);

  await stubThinWordText(stubWordText, {
    definition: null,
    translations: ["aspirar", "resoplar"],
  });

  await loadSnuff(page);
  const dictionaryWithNetwork = await textBeforeGeneratedBlock(page);

  // The network's own two lines, marked apart from both the dictionary's
  // translations and the generated example above them.
  await expect(page.getByText(messages.word.networkTranslations)).toBeVisible();
  await expect(page.getByText(messages.word.networkMark)).toBeVisible();
  await expect(page.getByText("aspirar", { exact: true })).toBeVisible();
  await expect(page.getByText("resoplar", { exact: true })).toBeVisible();
  await expect(page.locator("[data-network-translations]")).toHaveCount(1);

  await stubThinWordText(stubWordText, {
    definition: null,
    translations: null,
  });

  await loadSnuff(page);
  const dictionaryWithoutNetwork = await textBeforeGeneratedBlock(page);

  // The claim this module exists to prove: nothing above the generated
  // block moved a character for `translations` arriving or not.
  expect(dictionaryWithoutNetwork).toBe(dictionaryWithNetwork);

  // `translations: null` draws exactly today's screen — no hairline, no
  // heading, no line gained anywhere in the generated block either.
  await expect(page.locator("[data-network-translations]")).toHaveCount(0);
  await expect(page.getByText(messages.word.networkTranslations)).toHaveCount(0);
  await expect(page.getByText(messages.word.networkMark)).toHaveCount(0);
});

test("a thin word with an empty translations array draws no network block, same as null", async ({
  page,
  stubWordText,
}) => {
  await deleteTranslator(page);

  await stubThinWordText(stubWordText, {
    definition: null,
    translations: [],
  });

  await loadSnuff(page);

  await expect(page.locator("[data-network-translations]")).toHaveCount(0);
  await expect(page.getByText(messages.word.networkTranslations)).toHaveCount(0);
});
