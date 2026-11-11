/**
 * The planned payment's edit dialog against a version that moved (Q24, RNF-10):
 * two tabs open the same payment, the second to save wins, and the first is told
 * to reopen it, with what it typed still on screen and the other tab's figure
 * standing in the database.
 *
 * Written from the contract (plan M46/M48), not from the dialog: the refusal line
 * is the catalogue's `errors.stale`, shown inside the dialog.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const payments = messages.plannedPayments;
const common = messages.common;

test.use({ viewport: { width: 1280, height: 900 } });

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const ids = { account: randomUUID(), payment: randomUUID() };
const CONCEPT = `Pago planeado ${stamp}`;

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.account}, ${scope.userId}, ${`Cuenta de pago ${stamp}`}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into planned_payments (id, from_account_id, amount_cents, due_date, description)
      values (${ids.payment}, ${ids.account}, 2000000, '2027-03-12', ${CONCEPT})`;
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from planned_payments where id = ${ids.payment}`;
  await fixtureSql`delete from accounts where id = ${ids.account}`;
});

async function openEdit(tab: Page): Promise<Locator> {
  await tab.goto("/es/planning/payments");
  await tab
    .getByRole("button", { name: common.actionsFor.replace("{name}", CONCEPT), exact: true })
    .filter({ visible: true })
    .click();
  await tab.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = tab.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: payments.conceptLabel })).toHaveValue(CONCEPT);
  return dialog;
}

const save = (dialog: Locator) => dialog.getByRole("button", { name: payments.save, exact: true });
const amount = (dialog: Locator) => dialog.getByRole("textbox", { name: payments.amountLabel });

async function storedAmount(): Promise<string> {
  const [row] = await fixtureSql<{ amount_cents: string }[]>`
    select amount_cents::text as amount_cents from planned_payments where id = ${ids.payment}`;
  return row.amount_cents;
}

test("a payment nobody else touched saves, even after the dialog sat open", async ({ page }) => {
  // Kills: an expected version that never matches, so every ordinary edit is refused.
  const dialog = await openEdit(page);
  await amount(dialog).fill("27000");
  await save(dialog).click();

  await expect(dialog).toBeHidden();
  expect(await storedAmount()).toBe("2700000");
});
