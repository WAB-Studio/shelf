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
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  clearGroup,
  clearLedger,
  clearQueue,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const NAME = `T4 Mercado ${stamp}`;
// A fund category reads bare now (the user, 2026-10-30), so the fixture gives it a name of its own
// to tell the two scopes apart.
const MARKED = `${NAME} del fondo`;
const CREDENTIAL = `Credencial T4 ${stamp}`;

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

// The reports screen's bands sit directly under main.
function reportBand(page: Page): Locator {
  return page.locator("main > .rt-Box").filter({ visible: true });
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
      values (${ids.fundCategory}, ${groupId}, ${MARKED}, 'expense', '#8C4A4A')`;

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
});

test.afterAll(async () => {
  await clearQueue();
  await clearLedger();
  await fixtureSql`delete from transactions where description like ${`%${stamp}`}`;
  // The fund account's expense is the group's, not the harness user's: clearLedger misses it.
  await fixtureSql`delete from transactions where description = ${`Gasto T4 ${stamp}`}`;
  await fixtureSql`delete from webhook_credentials where name = ${CREDENTIAL}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.personalCategory, ids.fundCategory])}`;
  await fixtureSql`delete from accounts where id = ${ids.fundAccount}`;
  await clearGroup();
});

test.describe("reports", () => {
  test("the two scopes are two rows, each with its own figure, the larger first", async ({ page }) => {
    // Kills: row.name written bare (two alike rows); the order or the totals disturbed.
    await page.goto("/es/reports");

    const shown = reportBand(page);
    // Reportes marks the fund's scope with «· fondo» (the user, 2026-11-08).
    const FUND_ROW = `${MARKED} · fondo`;
    const fundRow = shown.getByText(FUND_ROW, { exact: true }).locator("..");
    const personalRow = shown.getByText(NAME, { exact: true }).locator("..");

    await expect(fundRow).toHaveCount(1);
    await expect(personalRow).toHaveCount(1);
    expect(await digitsOf(fundRow)).toContain(String(FUND_CENTS / 100));
    expect(await digitsOf(personalRow)).toContain(String(PERSONAL_CENTS / 100));
    await expect(shown.getByText(new RegExp(NAME)).first()).toHaveText(FUND_ROW);
  });
});
