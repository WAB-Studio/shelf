/**
 * RF-162 on the screen: a movement dated before the opening of its account is refused by the database,
 * and the person reads why. «Guardar movimiento» goes busy while the action runs, then the toast says the
 * words the user decided (docs/DESIGN.md), and the form stays open with what was typed, so the date can
 * be fixed and the form sent again without typing the rest.
 *
 * Nothing is read from the implementation: the words are the contract's text, written here, and the
 * rows are read back from Postgres. It runs at both widths, 360 and 1280, because the toast can sit under
 * a sheet at the narrow one.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;

// The contract's text, written here so a missing message key fails the test and not the compile.
const WORDS = "La fecha es anterior a la apertura de la cuenta. Cambia la fecha o la apertura de la cuenta.";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const ACCOUNT_NAME = `O6M7 Banco ${stamp}`;
const accountId = randomUUID();
const today = todayInBogota();
const OPENING = addCivilDays(today, -5);
const BEFORE = addCivilDays(today, -6);
const AFTER = addCivilDays(today, -4);
const NOTE = `O6M7 nota ${stamp}`;
const categoryId = randomUUID();

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${scope.userId}, ${ACCOUNT_NAME}, 'asset', 'bank', 50000000, ${OPENING})`;
    // The category a seeded movement's split needs; torn down in afterAll so a later spec in this
    // identity reads no category of ours.
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${`O6 categoría ${stamp}`}, 'expense', '#4C8C4A')`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`delete from accounts where id = ${accountId}`;
  await fixtureSql`delete from categories where id = ${categoryId}`;
});

test.beforeEach(async () => {
  await clearLedger();
});

test.afterEach(async () => {
  await clearLedger();
});

const isDesktop = (testInfo: TestInfo) => testInfo.project.name === "desktop";
const field = (dialog: Locator, id: string) => dialog.locator(`#${id}`);
const saveButton = (dialog: Locator) => dialog.getByRole("button", { name: transactions.saveMovement, exact: true });

async function openFullForm(page: Page, testInfo: TestInfo): Promise<Locator> {
  await page.goto("/es");
  if (isDesktop(testInfo)) {
    await page.getByRole("button", { name: transactions.quickTypeLink, exact: true }).click();
  } else {
    await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
    await page.getByRole("link", { name: transactions.quickTypeLink, exact: true }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("form").getByRole("heading", { name: transactions.formTitle })).toBeVisible();
  return dialog;
}

async function choose(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function fill(page: Page, dialog: Locator, date: string) {
  await choose(page, field(dialog, "movement-from"), ACCOUNT_NAME);
  await field(dialog, "movement-amount").fill("4000");
  const tile = dialog.getByRole("button", { name: scope.categoryName, exact: true });
  const more = dialog.getByRole("button", { name: transactions.categoryMore, exact: true });
  await expect(tile.or(more).first()).toBeVisible();
  if (!(await tile.isVisible())) await more.click();
  await tile.click();
  await field(dialog, "movement-date").fill(date);
  await field(dialog, "movement-note").fill(NOTE);
}

async function rows() {
  return fixtureSql<{ occurred_at: string }[]>`
    select occurred_at::text as occurred_at from transactions where from_account_id = ${accountId}`;
}

const toasts = (page: Page) => page.locator("[data-sonner-toaster]");

// toBeVisible does not see a dialog drawn over the toast; the element at the toast's centre does.
async function expectTopmost(toast: Locator) {
  await expect(toast).toBeVisible();
  await expect
    .poll(() =>
      toast.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && node.contains(hit);
      }),
    )
    .toBe(true);
}

const accounts = messages.accounts;

// A movement on the account, dated on its opening day, with the category its split needs.
async function seedMovementOnOpening(transactionId: string) {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${transactionId}, ${accountId}, 400000, ${OPENING}, ${NOTE})`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${transactionId}, ${categoryId}, 400000)`;
  });
}
const WORDS_OPENING = "Hay movimientos antes de esa fecha. La apertura no puede quedar después de ellos.";

test.describe("a date before the account's opening", () => {
  let release: () => void = () => {};

  test.beforeEach(({ page }) => {
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    return page.route(
      (url) => url.pathname.startsWith("/es"),
      async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"]) await gate;
        await route.continue().catch(() => {});
      },
    );
  });

  test.afterEach(() => release());

  test("«Guardar movimiento» goes busy, then the toast says why, and the form keeps what was typed", async ({ page }, testInfo) => {
    // Kills: the refusal read as «algo salió mal», the form closed over the typed values, or a row written.
    const dialog = await openFullForm(page, testInfo);
    await fill(page, dialog, BEFORE);

    await saveButton(dialog).click();
    await expect(saveButton(dialog)).toBeDisabled();
    release();

    await expectTopmost(toasts(page).getByText(WORDS, { exact: true }));
    await expect(dialog.getByText(WORDS, { exact: true })).toBeVisible();
    await expect(toasts(page).getByText(messages.errors.unexpected, { exact: true })).toHaveCount(0);

    await expect(dialog).toBeVisible();
    await expect(saveButton(dialog)).toBeEnabled();
    await expect(field(dialog, "movement-amount")).toHaveValue(/4\D?000/);
    await expect(field(dialog, "movement-date")).toHaveValue(BEFORE.split("-").reverse().join("/"));
    await expect(field(dialog, "movement-note")).toHaveValue(NOTE);
    expect(await rows()).toEqual([]);
  });

  test("the same form, with the date moved to the opening day, is saved", async ({ page }, testInfo) => {
    // Kills: a refusal that holds for the opening day itself, or a form left stuck after a refusal.
    const dialog = await openFullForm(page, testInfo);
    await fill(page, dialog, BEFORE);
    release();

    await saveButton(dialog).click();
    await expect(toasts(page).getByText(WORDS, { exact: true })).toBeVisible();

    await field(dialog, "movement-date").fill(OPENING);
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect((await rows()).map((row) => row.occurred_at)).toEqual([OPENING]);
  });

  test("a date after the opening is saved at once, and no refusal is shown", async ({ page }, testInfo) => {
    // Kills: the words shown for a date that is fine.
    release();
    const dialog = await openFullForm(page, testInfo);
    await fill(page, dialog, AFTER);
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText(WORDS, { exact: true })).toHaveCount(0);
    expect((await rows()).map((row) => row.occurred_at)).toEqual([AFTER]);
  });

  test("an edit dated before the opening: the toast is on top and the date field says why", async ({ page }) => {
    // Kills: the edit form refusing out of sight, or only in a toast.
    release();
    const transactionId = randomUUID();
    await seedMovementOnOpening(transactionId);
    await page.goto(`/es/movements/${transactionId}`);
    await page.getByRole("button", { name: transactions.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await field(dialog, "movement-date").fill(BEFORE);
    await saveButton(dialog).click();

    await expectTopmost(toasts(page).getByText(WORDS, { exact: true }));
    await expect(dialog.getByText(WORDS, { exact: true })).toBeVisible();
    await expect(field(dialog, "movement-date")).toHaveValue(BEFORE.split("-").reverse().join("/"));
    await expect(field(dialog, "movement-note")).toHaveValue(NOTE);
  });

  test("an opening moved past a movement: the toast is on top and the opening-day field says why", async ({ page }) => {
    // Kills: the account form refusing out of sight, or only in a toast.
    release();
    await seedMovementOnOpening(randomUUID());
    await page.goto("/es/settings/accounts");
    await page
      .getByRole("button", { name: messages.common.actionsFor.replace("{name}", ACCOUNT_NAME), exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("menuitem", { name: messages.common.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await field(dialog, "account-balance-on").fill(AFTER);
    await dialog.getByRole("button", { name: messages.common.save, exact: true }).click();

    await expectTopmost(toasts(page).getByText(WORDS_OPENING, { exact: true }));
    await expect(dialog.getByText(WORDS_OPENING, { exact: true })).toBeVisible();
    await expect(field(dialog, "account-balance-on")).toHaveValue(AFTER.split("-").reverse().join("/"));
    expect(accounts.errors.openingAfterMovement).toBe(WORDS_OPENING);
  });
});
