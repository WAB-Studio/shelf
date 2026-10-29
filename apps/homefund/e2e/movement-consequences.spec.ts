/**
 * The consequence list of a movement's detail (RF-132): the page asks the
 * ledger for the movements whose cause is the one open, and for nothing else.
 * A cause with one charge lists that charge alone, an unrelated movement stays
 * out, and a movement that caused nothing draws no list. Each fact is read
 * from the links the page draws, by the id they point at.
 */

import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const scope = readScope();

let causeId = "";
let chargeId = "";
let unrelatedId = "";

// The movements the page links to, by id: the shape that is displayed at this width.
function linkTo(page: Page, id: string) {
  return page.locator(`main a[href$="/movements/${id}"]`).filter({ visible: true });
}

test.beforeEach(async () => {
  await clearLedger();

  await asHarnessUser(async (tx) => {
    const today = tx`(now() at time zone ${TIME_ZONE})::date`;
    const ids: string[] = [];

    const [cause] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${scope.accountId}, 4000000, ${today}, 'Harness causa')
      returning id`;
    const [charge] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description, caused_by_transaction_id)
      values (${scope.accountId}, 120000, ${today}, 'Harness cobro', ${cause.id})
      returning id`;
    const [unrelated] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${scope.accountId}, 700000, ${today}, 'Harness ajeno')
      returning id`;
    ids.push(cause.id, charge.id, unrelated.id);

    for (const [id, cents] of [
      [cause.id, 4000000],
      [charge.id, 120000],
      [unrelated.id, 700000],
    ] as const) {
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${id}, ${scope.categoryId}, ${cents})`;
    }

    [causeId, chargeId, unrelatedId] = ids;
  });
});

test.afterEach(async () => {
  await clearLedger();
});

test("a cause lists the one charge it caused and no other movement", async ({ page }) => {
  // Kills: the cause filter dropped from the ledger read (every movement is listed as a consequence of the open one).
  await page.goto(`/es/movements/${causeId}`);

  await expect(page.getByText(transactions.causedTitle, { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(linkTo(page, chargeId)).toHaveCount(1);
  await expect(linkTo(page, unrelatedId)).toHaveCount(0);
  await expect(linkTo(page, causeId)).toHaveCount(0);
});

test("a movement that caused nothing draws no consequence list", async ({ page }) => {
  // Kills: the same filter dropped (the movement lists the whole ledger under «Cobros»).
  await page.goto(`/es/movements/${unrelatedId}`);

  await expect(page.getByText("Harness ajeno").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(transactions.causedTitle, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(transactions.causedTotal, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await expect(linkTo(page, chargeId)).toHaveCount(0);
  await expect(linkTo(page, causeId)).toHaveCount(0);
});

test("a charge lists none, and links back to its cause alone", async ({ page }) => {
  // Kills: the filter dropped (the charge's page lists its cause and the unrelated movement as consequences).
  await page.goto(`/es/movements/${chargeId}`);

  await expect(linkTo(page, causeId).first()).toBeVisible();
  await expect(page.getByText(transactions.causedTitle, { exact: true }).filter({ visible: true })).toHaveCount(0);
  await expect(linkTo(page, unrelatedId)).toHaveCount(0);
});
