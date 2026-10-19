import { expect, test, STUB_HEADER } from "./fixtures";

import messages from "../messages/es.json";
import { PHRASE_DEBOUNCE_MS } from "../lib/query/settle";
import manifest from "../public/dictionary/manifest.json";

const KEYSTROKE_MS = 50;
// Margin after one debounce window for a request to reach the route handler.
const REQUEST_DELIVERY_MS = 400;

test("typing a word letter by letter asks the paid text route exactly once", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  const asked: string[] = [];
  await page.route("**/api/word/text", async (route) => {
    asked.push((route.request().postDataJSON() as { headword: string }).headword);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { [STUB_HEADER]: "1" },
      body: JSON.stringify({
        definition: null,
        example: { en: "The lighthouse guided the ships home.", es: "El faro guió a los barcos a casa." },
      }),
    });
  });

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();

  const box = page.getByRole("textbox", { name: messages.search.label });
  await box.click();
  await box.pressSequentially("lighthouse", { delay: KEYSTROKE_MS });
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + REQUEST_DELIVERY_MS);

  expect(asked).toEqual(["lighthouse"]);
});
