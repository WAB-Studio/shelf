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
const UNNAMED_SENTENCE =
  "Este movimiento saldó un pago planeado. Al eliminarlo, el pago vuelve a «Por pagar».";
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

async function seedOrdinaryExpense(): Promise<string> {
  let id = "";
  await asHarnessUser(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${scope.accountId}, 1500000, (now() at time zone 'America/Bogota')::date, 'Harness suelto')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${row.id}, ${scope.categoryId}, 1500000)`;
    id = row.id;
  });
  return id;
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

const isServerAction = (request: { method(): string; headers(): Record<string, string> }) =>
  request.method() === "POST" && "next-action" in request.headers();

test.describe("the sentence in the confirmation", () => {
  test("phone detail names the payment", async ({ page }, testInfo) => {
    // Kills: the confirmation keeps the generic sentence, or drops the payment's name.
    test.skip(testInfo.project.name !== "mobile", "the phone detail is the 360 board");
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    const dialog = await openDetailDelete(page, movementId);

    await expect(dialog.getByText(NAMED_SENTENCE, { exact: true })).toBeVisible();
    await expect(dialog.getByText(PLAIN_SENTENCE)).toHaveCount(0);
  });

  test("laptop detail names the payment", async ({ page }, testInfo) => {
    // Kills: only the phone detail learns the new sentence.
    test.skip(testInfo.project.name !== "desktop", "the laptop detail is the 1280 view");
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    const dialog = await openDetailDelete(page, movementId);

    await expect(dialog.getByText(NAMED_SENTENCE, { exact: true })).toBeVisible();
  });

  test("list row names the payment", async ({ page }, testInfo) => {
    // Kills: the list row's own dialog keeps reading the generic sentence.
    test.skip(testInfo.project.name !== "desktop", "the table is the 1280 list");
    await seedPayment(NAME);
    await settleThroughApp(page, NAME);

    await page.goto("/es/movements");
    const ledger = page.getByRole("table", { name: transactions.listTitle });
    await ledger
      .getByRole("button", { name: new RegExp(`^${common.actionsFor.replace("{name}", ".+")}$`) })
      .click();
    await page.getByRole("menuitem", { name: transactions.delete, exact: true }).click();

    const dialog = confirmDialog(page);
    await expect(dialog.getByText(NAMED_SENTENCE, { exact: true })).toBeVisible();
  });

  test("a payment with no description says «un pago planeado»", async ({ page }) => {
    // Kills: «saldó «null»» or an empty name for a nameless payment.
    await seedPayment(null);
    const movementId = await settleThroughApp(page, payments.noConcept);

    const dialog = await openDetailDelete(page, movementId);

    await expect(dialog.getByText(UNNAMED_SENTENCE, { exact: true })).toBeVisible();
  });

  test("a movement that settled nothing keeps «Esta acción no se puede deshacer.»", async ({
    page,
  }) => {
    // Kills: the payment sentence shown for every movement.
    const movementId = await seedOrdinaryExpense();

    const dialog = await openDetailDelete(page, movementId);

    await expect(dialog.getByText(PLAIN_SENTENCE, { exact: true })).toBeVisible();
    await expect(dialog.getByText("Por pagar")).toHaveCount(0);
  });
});

test.describe("confirming the delete of a settling movement", () => {
  test("pending: both buttons disabled, a spinner on «Eliminar», the dialog open", async ({
    page,
  }) => {
    // Kills: a dialog that stays clickable (a second delete) or shows no progress while held.
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/*", async (route) => {
      if (isServerAction(route.request())) await gate;
      await route.continue();
    });

    const dialog = await openDetailDelete(page, movementId);
    await confirmButton(dialog).click();

    await expect(confirmButton(dialog)).toBeDisabled();
    await expect(confirmButton(dialog).locator(".rt-Spinner")).toBeVisible();
    await expect(dialog.getByRole("button", { name: common.cancel, exact: true })).toBeDisabled();
    await expect(dialog).toBeVisible();

    release();
  });

  test("refused: the action's toast shows, the dialog stays and the payment stays done", async ({
    page,
  }) => {
    // Kills: a dialog that closes on failure, a silent failure, or a payment reverted before the delete lands.
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    await page.route("**/*", async (route) => {
      if (isServerAction(route.request())) await route.abort();
      else await route.continue();
    });

    const dialog = await openDetailDelete(page, movementId);
    await confirmButton(dialog).click();

    await expect(page.getByText(messages.errors.unexpected, { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(confirmButton(dialog)).toBeEnabled();
    const row = await paymentRow();
    expect(row.status).toBe("done");
    expect(row.settled_transaction_id).toBe(movementId);
  });

  test("«Cancelar» sends nothing and leaves the payment done", async ({ page }) => {
    // Kills: a cancel that deletes, or one that fires the action before the person confirms.
    await seedPayment(NAME);
    const movementId = await settleThroughApp(page, NAME);

    const dialog = await openDetailDelete(page, movementId);
    const sent: string[] = [];
    page.on("request", (request) => {
      if (isServerAction(request)) sent.push(request.url());
    });
    await dialog.getByRole("button", { name: common.cancel, exact: true }).click();

    await expect(dialog).toBeHidden();
    await page.waitForLoadState("networkidle");
    expect(sent).toEqual([]);
    const row = await paymentRow();
    expect(row.status).toBe("done");
    expect(row.settled_transaction_id).toBe(movementId);
  });

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
