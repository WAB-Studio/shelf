import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// `/registro/100%` itself 500s inside Next's router before the page runs
// (docs/TRAPS.md), so the malformed escape here is one the router accepts.
const RAW = "100%zz";

test("a word whose segment is not a valid escape is read as typed and does not crash", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  const response = await page.goto(`/registro/${RAW}`);

  expect(response?.status()).toBeLessThan(500);
  await expect(page.getByRole("heading", { name: RAW })).toBeVisible();
  await expect(page.getByText(messages.log.word.emptyBody.replace("{word}", RAW))).toBeVisible();
});
