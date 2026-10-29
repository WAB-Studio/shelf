import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// `/registro/100%` itself 500s inside Next's router before the page runs
// (docs/TRAPS.md), so the address here is the escaped percent the router accepts.
const SEGMENT = "100%25zz";
const WORD = "100%zz";

test("a word with an escaped percent opens its own page and does not crash", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  const response = await page.goto(`/registro/${SEGMENT}`);

  expect(response?.status()).toBeLessThan(500);
  await expect(page.getByRole("heading", { name: WORD })).toBeVisible();
  await expect(page.getByText(messages.log.word.emptyBody.replace("{word}", WORD))).toBeVisible();
});
