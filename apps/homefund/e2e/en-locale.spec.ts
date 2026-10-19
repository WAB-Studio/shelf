/**
 * The English screens read English (RF-46): each screen's title and primary
 * action equal `messages/en.json`'s, never a literal, so a fall back to `es`
 * fails here. Run at the phone's width, where the bottom bar's raised action is
 * the way into the quick sheet.
 */
import { expect } from "@playwright/test";

import en from "@/messages/en.json";

import { clearGroup, seedGroup, test } from "./global-setup";

test.beforeAll(async () => {
  await seedGroup();
});

test.afterAll(async () => {
  await clearGroup();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
});

test("/en Movements reads its title and offers the quick entry in English", async ({ page }) => {
  // Kills: i18n/request.ts falling back to es.
  await page.goto("/en/movements");
  await expect(page.getByRole("heading", { name: en.transactions.listTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en.nav.quickEntry, exact: true })).toBeVisible();
});

test("/en Planning → Budgets reads its title and «New budget»", async ({ page }) => {
  await page.goto("/en/planning/budgets");
  await expect(page.getByRole("heading", { name: en.budgets.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en.budgets.add, exact: true }).first()).toBeVisible();
});

test("/en Settings → Categories reads its title and «Add category»", async ({ page }) => {
  await page.goto("/en/settings/categories");
  await expect(page.getByRole("heading", { name: en.categories.title, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: en.categories.add, exact: true }).first()).toBeVisible();
});

test("/en quick entry sheet reads its title and «Save»", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("button", { name: en.transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: en.transactions.quickTitle, exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: en.transactions.quickSave, exact: true })).toBeVisible();
});
