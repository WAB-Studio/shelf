/**
 * A 60-character fund category at 360 px never pushes «Guardar» out of the
 * payment, recurring-rule or webhook dialog, and never cuts « · fondo» off a
 * budget card (RF-140, RF-74, RF-29, RF-86, RF-71).
 *
 * The leader drives it. The group, account and categories are seeded once and
 * dropped by id; the budgets are seeded with them.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, readScope, seedGroup, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

// The fund's categories carry no suffix any more; a personal one wears a glyph.
const FUND_MARK = "";
const LONG_CATEGORY = `${"Categoria larguisima del fondo ".repeat(2).slice(0, 52)}${stamp}`;
const PERSONAL_CATEGORY = `Categoria personal ${stamp}`;
const FUND_ACCOUNT = `Cuenta del fondo ${stamp}`;

const ids = {
  fundAccount: randomUUID(),
  longCategory: randomUUID(),
  personalCategory: randomUUID(),
  fundBudget: randomUUID(),
  personalBudget: randomUUID(),
};

let groupId = "";

test.beforeAll(async () => {
  expect(LONG_CATEGORY).toHaveLength(60);
  ({ groupId } = await seedGroup());
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.fundAccount}, ${groupId}, true, ${FUND_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.longCategory}, ${groupId}, ${LONG_CATEGORY}, 'expense', '#8C4A4A')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.personalCategory}, ${scope.userId}, ${PERSONAL_CATEGORY}, 'expense', '#4C8C4A')`;
    await tx`
      insert into budgets (id, group_id, category_id, period, limit_cents, threshold_pct)
      values (${ids.fundBudget}, ${groupId}, ${ids.longCategory}, 'monthly', 500000, 80)`;
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct)
      values (${ids.personalBudget}, ${scope.userId}, ${ids.personalCategory}, 'monthly', 700000, 80)`;
  });
});

test.afterAll(async () => {
  await fixtureSql`delete from budgets where id in ${fixtureSql([ids.fundBudget, ids.personalBudget])}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.longCategory, ids.personalCategory])}`;
  await fixtureSql`delete from accounts where id = ${ids.fundAccount}`;
  await clearGroup();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
});

async function pick(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// The long category chosen, then everything the dialog must still keep on screen.
async function expectSaveReachable(page: Page, dialog: Locator, save: string) {
  const button = dialog.getByRole("button", { name: save, exact: true });
  await expect(button).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const box = await button.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await button.click({ trial: true });
}

// The open list: the option answers to the whole name, on one line inside the screen.
async function expectOptionClamped(page: Page, trigger: Locator, name: string) {
  await trigger.click();
  const option = page.getByRole("option", { name });
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const clipped = await option.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("*")].some(
      (node) =>
        getComputedStyle(node).textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth,
    ),
  );
  expect(clipped).toBe(true);
  await page.keyboard.press("Escape");
  await expect(option).toBeHidden();
}

test.describe("a 60-character fund category in a dialog", () => {
  test("the payment dialog keeps «Guardar» on screen and the option its whole name", async ({ page }) => {
    // Kills: dropping the Box maxWidth around the item; slicing the name in JS.
    await page.goto("/es/planning/payments");
    await page.getByRole("button", { name: messages.plannedPayments.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await expectOptionClamped(page, dialog.locator("#payment-category"), LONG_CATEGORY + FUND_MARK);
    await pick(page, dialog.locator("#payment-category"), LONG_CATEGORY + FUND_MARK);

    await expectSaveReachable(page, dialog, messages.plannedPayments.save);
  });

  test("the recurring dialog keeps «Guardar regla» on screen", async ({ page }) => {
    // Kills: dropping the Box maxWidth around the item in recurring-form-dialog.
    await page.goto("/es/planning/recurring");
    await page.getByRole("button", { name: messages.recurringRules.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await pick(page, dialog.locator("#rule-account"), FUND_ACCOUNT);
    await expectOptionClamped(page, dialog.locator("#rule-category"), LONG_CATEGORY + FUND_MARK);
    await pick(page, dialog.locator("#rule-category"), LONG_CATEGORY + FUND_MARK);

    await expectSaveReachable(page, dialog, messages.recurringRules.save);
  });

  test("the webhook dialog keeps «Crear credencial» on screen", async ({ page }) => {
    // Kills: dropping the Box maxWidth around the item in webhook-credential-dialog.
    await page.goto("/es/settings/webhooks");
    await page.getByRole("button", { name: messages.webhooks.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The item also carries the kind badge, so the name is the whole name and then some.
    await expectOptionClamped(page, dialog.locator("#webhook-category"), LONG_CATEGORY + FUND_MARK);
    await dialog.locator("#webhook-category").click();
    await page.getByRole("option", { name: LONG_CATEGORY + FUND_MARK }).click();

    await expectSaveReachable(page, dialog, messages.webhooks.issue);
  });
});

test.describe("a budget card at 360 px", () => {
  // The phone lists cards; the table below them is hidden, so a card is found by its own class.
  function cardOf(page: Page, name: string): Locator {
    return page.locator(".rt-Card").filter({ hasText: name });
  }

  test("a fund budget on a 60-character category stays inside its card", async ({ page }) => {
    // Kills: an unclamped name pushing the card past the phone's width.
    await page.goto("/es/planning/budgets");
    const card = cardOf(page, LONG_CATEGORY);
    await expect(card).toHaveCount(1);
    const cardBox = await card.boundingBox();
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(360);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("a personal budget's card carries no mark", async ({ page }) => {
    // Kills: always rendering the mark.
    await page.goto("/es/planning/budgets");
    const card = cardOf(page, PERSONAL_CATEGORY);
    await expect(card).toHaveCount(1);
    await expect(card.getByText(PERSONAL_CATEGORY, { exact: true })).toBeVisible();
  });
});
