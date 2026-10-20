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

async function openReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
}

// "cat" is a headword and the prefix of another, "catch": the one pair where
// a decoration that asked on every settled keystroke would pay for a word the
// reader never meant. The stub answers 204, so no model is reached.
test("a headword typed over by a longer one is never asked about, only the one the reader stops on", async ({
  page,
}) => {
  await deleteTranslator(page);
  const asked: string[] = [];
  const catchAsked = page.waitForRequest((request) => {
    if (!request.url().includes("/api/word/text")) return false;
    const { headword } = request.postDataJSON() as { headword: string };
    asked.push(headword);
    return headword === "catch";
  });
  await openReady(page);

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.fill("cat");
  // The word is classified and painted: from here on its decoration timer runs.
  await expect(page.getByText("gato", { exact: false }).first()).toBeVisible();
  await box.fill("catch");
  await catchAsked;

  expect(asked).toEqual(["catch"]);
});
