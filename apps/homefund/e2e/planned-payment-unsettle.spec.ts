/**
 * Deleting a movement that settled a planned payment (RF-161): the confirmation names
 * the payment and says it goes back to «Por pagar»; a movement that settled nothing
 * keeps the old sentence. Pending holds both buttons, a refusal leaves the dialog and
 * the payment alone, cancelling sends nothing, and confirming puts the payment back
 * among the ones still to pay.
 *
 * Written from the board `MovimientoEliminarSaldoPagoMovil` (docs/DESIGN.md), not from
 * the dialogs. The payment is settled through the app's own «Registrar pago» dialog, so
 * the link between payment and movement is the one the app writes.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const payments = messages.plannedPayments;
const common = messages.common;
const scope = readScope();

const NAME = "Matrícula";
const NAMED_SENTENCE =
  "Este movimiento saldó «Matrícula». Al eliminarlo, el pago vuelve a «Por pagar».";
const PLAIN_SENTENCE = "Esta acción no se puede deshacer.";

let paymentId = "";

async function seedPayment(description: string | null): Promise<void> {
  paymentId = randomUUID();
  const today = todayInBogota();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into planned_payments (
        id, owner_user_id, from_account_id, amount_cents, category_id, due_date, remind_on,
        description, created_by)
      values (${paymentId}, ${scope.userId}, ${scope.accountId}, 4300000, ${scope.categoryId},
        ${today}, ${today}, ${description}, ${scope.userId})`;
  });
}

// «Registrar pago» through the dialog, from whichever list the viewport paints.
async function settleThroughApp(page: Page, label: string): Promise<string> {
  await page.goto("/es/planning/payments");
  await page
    .getByRole("button", { name: common.actionsFor.replace("{name}", label), exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: payments.settle, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: payments.settle, exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => (await paymentRow()).settled_transaction_id)
    .not.toBeNull();
  return (await paymentRow()).settled_transaction_id as string;
}

async function paymentRow() {
  const [row] = await fixtureSql<{ status: string; settled_transaction_id: string | null }[]>`
    select status, settled_transaction_id from planned_payments where id = ${paymentId}`;
  return row;
}

test.beforeEach(async () => {
  await clearLedger();
  await fixtureSql`delete from planned_payments where owner_user_id = ${scope.userId}`;
  paymentId = "";
});

test.afterEach(async () => {
  await clearLedger();
  await fixtureSql`delete from planned_payments where owner_user_id = ${scope.userId}`;
});

const confirmDialog = (page: Page) => page.getByRole("alertdialog");
const confirmButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: transactions.delete, exact: true });

async function openDetailDelete(page: Page, movementId: string): Promise<Locator> {
  await page.goto(`/es/movements/${movementId}`);
  await page
    .getByRole("button", { name: transactions.delete, exact: true })
    .filter({ visible: true })
    .click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("the sentence in the confirmation", () => {
  test("phone detail names the payment @mobile", async ({ page }, testInfo) => {
    // Kills: the confirmation keeps the generic sentence, or drops the payment's name.
    test.skip(testInfo.project.name !== "mobile", "the phone detail is the 360 board");
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    const dialog = await openDetailDelete(page, movementId);

    await expect(dialog.getByText(NAMED_SENTENCE, { exact: true })).toBeVisible();
    await expect(dialog.getByText(PLAIN_SENTENCE)).toHaveCount(0);
  });
});

test.describe("confirming the delete of a settling movement", () => {

  test("done: the payment is under «Por pagar» again and Planeación offers it to settle", async ({
    page,
  }, testInfo) => {
    // Kills: a delete that removes the movement and leaves the payment done, so nothing is owed any more.
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    const dialog = await openDetailDelete(page, movementId);
    await confirmButton(dialog).click();
    await expect(page).toHaveURL(/\/es\/movements$/);

    await expect
      .poll(async () => (await paymentRow()).status)
      .toBe("pending");
    expect((await paymentRow()).settled_transaction_id).toBeNull();

    await page.goto("/es");
    await expect(page.getByRole("heading", { name: "Por pagar", level: 2 })).toBeVisible();
    await expect(page.getByRole("link").filter({ hasText: NAME })).toHaveCount(1);

    await page.goto("/es/planning/payments");
    if (testInfo.project.name === "desktop") {
      const row = page.getByRole("row").filter({ hasText: NAME });
      await expect(row.getByRole("button", { name: payments.settle, exact: true })).toBeVisible();
      await expect(row.getByText(payments.settledMarker, { exact: true })).toHaveCount(0);
    }
  });
});
