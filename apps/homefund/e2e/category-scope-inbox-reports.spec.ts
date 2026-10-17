/**
 * A fund category reads `{name} · fondo` on a delivery's card and row, on a
 * webhook credential's row and in its issue dialog, and in this month's
 * expenses by category (RF-140, RF-34). The person holds a personal category
 * and the fund holds one of the same name; only the mark tells them apart.
 *
 * Every row is written under the harness identity and dropped by id; the
 * credential the dialog issues is dropped by its stamped name; the group goes
 * through `clearGroup`.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  clearGroup,
  clearLedger,
  clearQueue,
  readScope,
  seedGroup,
  seedQueue,
  test,
} from "./global-setup";

const webhooks = messages.webhooks;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const NAME = `T4 Mercado ${stamp}`;
const MARKED = messages.categories.scopedName.replace("{name}", NAME);
const CREDENTIAL = `Credencial T4 ${stamp}`;
const MERCHANT = `Tienda T4 ${stamp}`;

// The fund's spend is the larger, so it sorts first.
const FUND_CENTS = 30_000_000;
const PERSONAL_CENTS = 12_000_000;

const ids = {
  fundAccount: randomUUID(),
  personalCategory: randomUUID(),
  fundCategory: randomUUID(),
};

// The digits of a rendered amount: separators and currency mark are `Intl`'s.
async function digitsOf(locator: Locator): Promise<string> {
  return ((await locator.innerText()).match(/\d/g) ?? []).join("");
}

function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The reports screen's bands sit directly under main.
function reportBand(page: Page): Locator {
  return page.locator("main > .rt-Box").filter({ visible: true });
}

function laptop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 1024;
}

test.beforeAll(async () => {
  const { groupId } = await seedGroup();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.fundAccount}, ${groupId}, true, ${`Cuenta fondo ${stamp}`}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.personalCategory}, ${scope.userId}, ${NAME}, 'expense', '#4C8C4A')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.fundCategory}, ${groupId}, ${NAME}, 'expense', '#8C4A4A')`;

    for (const [account, category, cents] of [
      [ids.fundAccount, ids.fundCategory, FUND_CENTS],
      [scope.accountId, ids.personalCategory, PERSONAL_CENTS],
    ] as const) {
      const [expense] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${account}, ${cents}, (now() at time zone ${TIME_ZONE})::date, ${`Gasto T4 ${stamp}`})
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${expense.id}, ${category}, ${cents})`;
    }
  });
  await seedQueue([
    {
      merchant: MERCHANT,
      amountCents: 45_000,
      accountId: ids.fundAccount,
      categoryId: ids.fundCategory,
      categorySource: "merchant",
    },
  ]);
});

test.afterAll(async () => {
  await clearQueue();
  await clearLedger();
  // The fund account's expense is the group's, not the harness user's: clearLedger misses it.
  await fixtureSql`delete from transactions where description = ${`Gasto T4 ${stamp}`}`;
  await fixtureSql`delete from webhook_credentials where name = ${CREDENTIAL}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.personalCategory, ids.fundCategory])}`;
  await fixtureSql`delete from accounts where id = ${ids.fundAccount}`;
  await clearGroup();
});

test.describe("inbox", () => {
  test("the delivery proposing the fund's category reads it marked", async ({ page }) => {
    // Kills: the bare lookup kept in delivery-card (phone) or inbox-screen (laptop table).
    await page.goto("/es/inbox");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
    await expect(band(page).getByText(NAME, { exact: true })).toHaveCount(0);
    if (!laptop(page)) {
      await expect(
        band(page).getByText(messages.ingest.categoryFromMerchant, { exact: true }),
      ).toBeVisible();
    }
  });
});

test.describe("webhooks", () => {
  test("the issue dialog offers both categories apart and the row reads the marked one", async ({ page }) => {
    // Kills: the dialog's items or the row's line left bare.
    await page.goto("/es/settings/webhooks");
    await page.getByRole("button", { name: webhooks.add, exact: true }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: webhooks.nameLabel }).fill(CREDENTIAL);
    await dialog.getByRole("combobox", { name: webhooks.defaultCategoryLabel }).click();

    await expect(
      page.getByRole("option", { name: `${NAME} ${messages.categories.kindExpense}`, exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("option", { name: `${MARKED} ${messages.categories.kindExpense}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: webhooks.issue, exact: true }).click();
    await dialog.getByRole("button", { name: webhooks.tokenAcknowledge, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(band(page).getByText(CREDENTIAL, { exact: true })).toBeVisible();
    // The laptop's table names no defaults; the phone's card carries the line.
    if (!laptop(page)) {
      await expect(
        band(page).getByText(webhooks.defaultCategory.replace("{name}", MARKED), { exact: true }),
      ).toBeVisible();
    }

    await fixtureSql`delete from webhook_credentials where name = ${CREDENTIAL}`;
  });
});

test.describe("reports", () => {
  test("the two scopes are two rows, each with its own figure, the larger first", async ({ page }) => {
    // Kills: row.name written bare (two alike rows); the order or the totals disturbed.
    await page.goto("/es/reports");

    const shown = reportBand(page);
    const fundRow = shown.getByText(MARKED, { exact: true }).locator("..");
    const personalRow = shown.getByText(NAME, { exact: true }).locator("..");

    await expect(fundRow).toHaveCount(1);
    await expect(personalRow).toHaveCount(1);
    expect(await digitsOf(fundRow)).toContain(String(FUND_CENTS / 100));
    expect(await digitsOf(personalRow)).toContain(String(PERSONAL_CENTS / 100));
    await expect(shown.getByText(new RegExp(NAME)).first()).toHaveText(MARKED);
  });
});
