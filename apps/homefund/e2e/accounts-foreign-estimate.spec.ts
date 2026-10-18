/**
 * A foreign purchase on an asset account is confirmed on «Cuentas» (RF-123,
 * RF-137; Q18 a, boards C4a–C4d). The card of an asset account lists each
 * pending estimate under «Compras en otra moneda» with «Confirmar monto»; the
 * dialog is the debts screen's row body, and M54's refusal shows under the field.
 * Every figure that matters is read back from Postgres, not from the screen.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  MEMBER_STORAGE_STATE,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const settlement = messages.debts.settlement;
const debtErrors = messages.debts.errors;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const OPENING_CENTS = 200_000_000;
const USD_CENTS = 1_549;
const ESTIMATE_CENTS = 6_400_000;
const BILLED_PESOS = 66_120;
const BILLED_CENTS = BILLED_PESOS * 100;

// The board names the button; no message key carries it yet, so the words stand here.
const CONFIRM = "Confirmar monto";

const created: string[] = [];

async function seedForeignPurchase(options: {
  shared?: { groupId: string };
}): Promise<{ accountId: string; name: string; movementId: string; description: string }> {
  const accountId = randomUUID();
  const name = `Débito ${stamp}-${created.length}`;
  const description = `Netflix ${stamp}-${created.length}`;
  let movementId = "";
  const categoryId = options.shared ? randomUUID() : scope.categoryId;
  await asHarnessUser(async (tx) => {
    if (options.shared) {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${categoryId}, ${options.shared.groupId}, ${`Fondo ${stamp}`}, 'expense', '#8C4A4A')`;

      await tx`
        insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${accountId}, ${options.shared.groupId}, true, ${name}, 'asset', 'bank', ${OPENING_CENTS}, ${todayInBogota()})`;
    } else {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${accountId}, ${scope.userId}, ${name}, 'asset', 'bank', ${OPENING_CENTS}, ${todayInBogota()})`;
    }
    created.push(accountId);
    const [movement] = await tx<{ id: string }[]>`
      insert into transactions (
        from_account_id, amount_cents, occurred_at, description,
        currency, counter_amount_cents, counter_is_estimate)
      values (${accountId}, ${USD_CENTS}, ${todayInBogota()}, ${description},
        'USD', ${ESTIMATE_CENTS}, true)
      returning id`;
    movementId = movement.id;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${movementId}, ${categoryId}, ${USD_CENTS})`;
  });
  return { accountId, name, movementId, description };
}

async function seedPlainAccount(): Promise<{ accountId: string; name: string }> {
  const accountId = randomUUID();
  const name = `Débito sin compras ${stamp}`;
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${scope.userId}, ${name}, 'asset', 'bank', ${OPENING_CENTS}, ${todayInBogota()})`;
  });
  created.push(accountId);
  return { accountId, name };
}

async function movementState(id: string) {
  const [row] = await fixtureSql<{ counter: string; estimate: boolean }[]>`
    select counter_amount_cents::text as counter, counter_is_estimate as estimate
    from transactions where id = ${id}`;
  return row;
}

function visible(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).filter({ visible: true });
}

const digitsOf = async (text: string) => Number(text.replace(/\D/g, ""));

test.afterEach(async () => {
  while (created.length > 0) {
    const id = created.pop() as string;
    await fixtureSql`delete from transactions where from_account_id = ${id} or to_account_id = ${id}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${id}`;
    await fixtureSql`delete from accounts where id = ${id}`;
  }
});

test("Pending: an asset account lists its estimate with «Confirmar monto»", async ({ page }) => {
  const seeded = await seedForeignPurchase({});
  await page.goto("/es/settings/accounts");

  await expect(page.getByText(seeded.name, { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(settlement.title, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText(seeded.description, { exact: false }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText(settlement.estimate, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(visible(page, CONFIRM)).toHaveCount(1);
});

test("Done: confirming stores the billed amount, toasts, and the purchase leaves the card", async ({ page }) => {
  const seeded = await seedForeignPurchase({});
  await page.goto("/es/settings/accounts");
  await visible(page, CONFIRM).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const label of [settlement.spent, settlement.estimate, settlement.rate]) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  expect(await digitsOf(await dialog.getByText(settlement.spent, { exact: true }).locator("..").innerText())).toBe(USD_CENTS);
  expect(await digitsOf(await dialog.getByText(settlement.estimate, { exact: true }).locator("..").innerText())).toBe(ESTIMATE_CENTS / 100);

  await dialog.getByLabel(settlement.billedLabel).fill(String(BILLED_PESOS));
  await dialog.getByRole("button", { name: settlement.save, exact: true }).click();

  await expect(page.getByText(settlement.saved, { exact: true })).toBeVisible();
  await expect(page.getByText(settlement.replacedEstimate, { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(seeded.description, { exact: false }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(settlement.title, { exact: true }).filter({ visible: true })).toHaveCount(0);

  expect(await movementState(seeded.movementId)).toEqual({ counter: String(BILLED_CENTS), estimate: false });
  const [pocket] = await fixtureSql<{ balance_cents: string }[]>`
    select balance_cents::text as balance_cents from account_balances
    where id = ${seeded.accountId} and currency = 'COP'`;
  expect(Number(pocket.balance_cents)).toBe(OPENING_CENTS - BILLED_CENTS);
});

test("Refused: a reconciliation on the purchase's day shows M54's line, keeps the dialog, writes nothing", async ({ page }) => {
  const seeded = await seedForeignPurchase({});
  await asHarnessUser(async (tx) => {
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${seeded.accountId}, ${todayInBogota()}, ${OPENING_CENTS})`;
  });
  const before = await fixtureSql<{ n: string }[]>`
    select count(*)::text as n from transactions
    where from_account_id = ${seeded.accountId} or to_account_id = ${seeded.accountId}`;

  await page.goto("/es/settings/accounts");
  await visible(page, CONFIRM).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(settlement.billedLabel).fill(String(BILLED_PESOS));
  await dialog.getByRole("button", { name: settlement.save, exact: true }).click();

  await expect(dialog.getByText(debtErrors.beforeReconciliation, { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByText(settlement.saved, { exact: true })).toHaveCount(0);

  expect(await movementState(seeded.movementId)).toEqual({ counter: String(ESTIMATE_CENTS), estimate: true });
  const after = await fixtureSql<{ n: string }[]>`
    select count(*)::text as n from transactions
    where from_account_id = ${seeded.accountId} or to_account_id = ${seeded.accountId}`;
  expect(after[0].n).toBe(before[0].n);
});

test("Empty: an asset account with no estimate draws no section and no button", async ({ page }) => {
  const plain = await seedPlainAccount();
  await page.goto("/es/settings/accounts");

  await expect(page.getByText(plain.name, { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(settlement.title, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await expect(visible(page, CONFIRM)).toHaveCount(0);
});

test.describe("under a plain member", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("a reader of a shared account is offered no «Confirmar monto»", async ({ page }) => {
    const { groupId } = await seedGroup();
    try {
      const seeded = await seedForeignPurchase({ shared: { groupId } });
      await page.goto("/es/settings/accounts");

      await expect(page.getByText(seeded.name, { exact: false }).filter({ visible: true }).first()).toBeVisible();
      await expect(visible(page, CONFIRM)).toHaveCount(0);
      expect((await movementState(seeded.movementId)).estimate).toBe(true);
    } finally {
      while (created.length > 0) {
        const id = created.pop() as string;
        await fixtureSql`delete from transactions where from_account_id = ${id} or to_account_id = ${id}`;
        await fixtureSql`delete from accounts where id = ${id}`;
      }
      await fixtureSql`delete from categories where name = ${`Fondo ${stamp}`}`;
      await clearGroup();
    }
  });
});
