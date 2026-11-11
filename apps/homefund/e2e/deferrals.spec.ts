/**
 * «Diferir en cuotas» on a card purchase (RF-136): a person confirms the count on the movement's
 * detail, the debt's detail then lists the purchase under «Compras diferidas» as «Cuota k de N», and
 * «Quitar diferido» takes it back. The count is refused outside 2 to 72, and the app never defers
 * on its own: a purchase nobody confirmed is not listed.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { asHarnessUser, readScope, test } from "./global-setup";

const deferrals = messages.deferrals;
const scope = readScope();

const cardId = randomUUID();
const purchaseId = randomUUID();
const PURCHASE_CENTS = 3_600_000;

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const today = tx`(now() at time zone ${TIME_ZONE})::date`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${cardId}, ${scope.userId}, 'Harness tarjeta diferida', 'liability', 'card', 0, ${today})`;
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${purchaseId}, ${cardId}, ${PURCHASE_CENTS}, ${today}, 'Harness nevera')`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${purchaseId}, ${scope.categoryId}, ${PURCHASE_CENTS})`;
  });
});

test.afterAll(async () => {
  await asHarnessUser(async (tx) => {
    await tx`delete from transactions where id = ${purchaseId}`;
    await tx`delete from accounts where id = ${cardId}`;
  });
});

test("a person defers a card purchase, sees it on the debt, and removes it", async ({ page }) => {
  // Kills: the deferral written without the person's confirmation, never listed on the debt, or never removable.
  await page.goto(`/es/planning/debts/${cardId}`);
  await expect(page.getByText(deferrals.title, { exact: true })).toHaveCount(0);

  await page.goto(`/es/movements/${purchaseId}`);
  await page.getByRole("button", { name: deferrals.action }).filter({ visible: true }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(deferrals.instalmentsLabel).fill("1");
  await dialog.getByRole("button", { name: deferrals.save }).click();
  await expect(dialog.getByText(deferrals.errors.instalmentsInvalid)).toBeVisible();

  await dialog.getByLabel(deferrals.instalmentsLabel).fill("36");
  await dialog.getByRole("button", { name: deferrals.save }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: deferrals.remove }).filter({ visible: true })).toBeVisible();

  await page.goto(`/es/planning/debts/${cardId}`);
  await expect(page.getByText(deferrals.title, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Harness nevera").filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/^Cuota 1 de 36 · .* al mes$/).filter({ visible: true })).toBeVisible();

  await page.goto(`/es/movements/${purchaseId}`);
  await page.getByRole("button", { name: deferrals.remove }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: deferrals.action }).filter({ visible: true })).toBeVisible();

  await page.goto(`/es/planning/debts/${cardId}`);
  await expect(page.getByText(deferrals.title, { exact: true })).toHaveCount(0);
});
