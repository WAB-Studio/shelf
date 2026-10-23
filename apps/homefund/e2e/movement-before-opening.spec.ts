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

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${scope.userId}, ${ACCOUNT_NAME}, 'asset', 'bank', 50000000, ${OPENING})`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`delete from accounts where id = ${accountId}`;
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
  await choose(page, dialog.getByRole("combobox", { name: transactions.splitRowCategory.replace("{position}", "1"), exact: true }), scope.categoryName);
  await field(dialog, "movement-date").fill(date);
  await field(dialog, "movement-note").fill(NOTE);
}

async function rows() {
  return fixtureSql<{ occurred_at: string }[]>`
    select occurred_at::text as occurred_at from transactions where from_account_id = ${accountId}`;
}

const toasts = (page: Page) => page.locator("[data-sonner-toaster]");

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

    await expect(toasts(page).getByText(WORDS, { exact: true })).toBeVisible();
    await expect(toasts(page).getByText(messages.errors.unexpected, { exact: true })).toHaveCount(0);

    await expect(dialog).toBeVisible();
    await expect(saveButton(dialog)).toBeEnabled();
    await expect(field(dialog, "movement-amount")).toHaveValue(/4\D?000/);
    await expect(field(dialog, "movement-date")).toHaveValue(BEFORE);
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
});
