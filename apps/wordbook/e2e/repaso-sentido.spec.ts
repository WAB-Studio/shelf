import { expect, pageTasks, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// RL-85, RL-91: the sense a card draws is the one the reader taps in the answer; with no tap, the one most plausibly meant.

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function openSnuff(page: Page): Promise<void> {
  await page.goto("/?q=snuff");
  await expect(page.getByRole("heading", { name: "snuff", exact: true })).toBeVisible({ timeout: 10000 });
  await pageTasks(page);
}

test("with no tap the first sense is the one learned, and a tap on another moves it and keeps it", async ({ page }) => {
  await deleteTranslator(page);
  await openSnuff(page);

  const learning = page.getByText(messages.word.learningThisSense, { exact: true });
  const offers = page.getByRole("button", { name: messages.word.learnThisSense });
  await expect(learning).toHaveCount(1);
  const others = await offers.count();
  expect(others).toBeGreaterThan(0);

  await offers.first().click();
  await expect(learning).toHaveCount(1);
  await expect(offers).toHaveCount(others);

  await page.reload();
  await expect(page.getByRole("heading", { name: "snuff", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(learning).toHaveCount(1);
  await expect(offers).toHaveCount(others);
  // The first sense no longer holds the mark: its own offer is back.
  await expect(offers.first()).toBeVisible();
});

test("RL-91: with no tap, «tree» is asked as the noun «árbol», not as the verb «enarbolar»", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/?q=tree");
  await expect(page.getByRole("heading", { name: "tree", exact: true })).toBeVisible({ timeout: 10000 });
  await pageTasks(page);

  await page.goto("/repaso");
  await expect(page.getByRole("heading", { name: "tree", exact: true })).toBeVisible();
  await page.getByRole("button", { name: messages.review.show }).click();
  await expect(page.getByText(messages.word.pos.n, { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/árbol/).first()).toBeVisible();
  await expect(page.getByText(/enarbolar/)).toHaveCount(0);
});
