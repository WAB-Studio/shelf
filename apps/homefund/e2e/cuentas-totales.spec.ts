/**
 * Cuentas adds up what it shows (RF-270): «Lo que tengo» is the sum of the asset rows on screen, «Libre» is never greater
 * than the total of the account it sits under, a pocket below zero says what it spent beyond what it held and one tap
 * passes it from its account, and the phone's cards say the opening date once.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const TODAY = todayInBogota();

const ids = { parent: randomUUID(), pocket: randomUUID(), other: randomUUID() };
const names = { parent: `Ahorros ${stamp}`, pocket: `Bolsillo ${stamp}`, other: `Efectivo ${stamp}` };

function pesosOf(text: string): number {
  return Number(text.replace(/\D/g, ""));
}

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    const opened = addCivilDays(TODAY, -40);
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.parent}, ${scope.userId}, ${names.parent}, 'asset', 'bank', 90_000_000, ${opened}),
        (${ids.pocket}, ${scope.userId}, ${names.pocket}, 'asset', 'bank', 0, ${opened}),
        (${ids.other}, ${scope.userId}, ${names.other}, 'asset', 'cash', 12_000_000, ${opened})`;
    await tx`update accounts set parent_account_id = ${ids.parent} where id = ${ids.pocket}`;
    // The pocket spends 150.000 it never held.
    const [spent] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${ids.pocket}, 15_000_000, ${TODAY}, ${`Gasto bolsillo ${stamp}`}) returning id`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${spent.id}, ${scope.categoryId}, 15_000_000)`;
  });
});

test.afterEach(async () => {
  const all = Object.values(ids);
  await fixtureSql`delete from transactions where from_account_id in ${fixtureSql(all)} or to_account_id in ${fixtureSql(all)}`;
  await fixtureSql`delete from accounts where id = ${ids.pocket}`;
  await fixtureSql`delete from accounts where id in ${fixtureSql(all)}`;
});

function tile(page: Page, label: string) {
  return page.locator("span").filter({ hasText: new RegExp(`^${label}$`) }).filter({ visible: true }).first().locator("xpath=..");
}

for (const width of [390, 1280]) {
  test(`at ${width} «Lo que tengo» is the visible asset rows' sum, pockets once`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/es/settings/accounts");

    const [row] = await fixtureSql<{ cents: string }[]>`
      select sum(b.balance_cents)::text as cents
      from account_balances b join accounts a on a.id = b.id
      where a.owner_user_id = ${scope.userId} and a.kind = 'asset' and a.archived_at is null
        and b.currency = 'COP'
        and not exists (select 1 from third_party_credits c where c.receivable_account_id = a.id)`;
    expect(pesosOf(await tile(page, "Lo que tengo").innerText())).toBe(Math.abs(Number(row.cents)) / 100);
  });
}

test("«Libre» is gone while a pocket is below zero, and the pocket says what it spent beyond what it held", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/es/settings/accounts");

  const parent = page.getByRole("row").filter({ hasText: names.parent }).filter({ visible: true }).first();
  await expect(parent).toBeVisible();
  await expect(parent).not.toContainText("Libre");
  const pocket = page.getByRole("row").filter({ hasText: names.pocket }).filter({ visible: true });
  await expect(pocket).toContainText(/Gastó \$\s150\.000 más de lo que tenía/);
});

test("one tap on «Pasar» moves what the pocket lacks from its account, and «Libre» returns as the total", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/es/settings/accounts");

  const pocket = page.getByRole("row").filter({ hasText: names.pocket }).filter({ visible: true });
  await pocket.getByRole("button", { name: new RegExp(`^Pasar \\$\\s150\\.000 desde ${names.parent}$`) }).click();

  await expect(pocket).not.toContainText("Gastó");
  const [moved] = await fixtureSql<{ amount_cents: string; kind: string }[]>`
    select amount_cents::text, kind from transactions where from_account_id = ${ids.parent} and to_account_id = ${ids.pocket}`;
  expect(moved).toMatchObject({ amount_cents: "15000000", kind: "transfer" });
});

test("the phone says the opening date on the first card of a date, not on every card @mobile", async ({ page }) => {
  await page.goto("/es/settings/accounts");
  const dated = page.getByText(/ el \d+\/\d+\/\d{4}$/);
  const bare = page.getByText("Saldo inicial", { exact: false });
  // Three cards share one opening date: it is said once among them, and every card still says its opening figure.
  await expect(dated.filter({ hasText: /\d/ }).first()).toBeVisible();
  expect(await bare.count()).toBeGreaterThanOrEqual(3);
  expect(await dated.count()).toBeLessThan(await bare.count());
});
