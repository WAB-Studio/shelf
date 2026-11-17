/**
 * RF-253 from the screen: «Cuadrar todo» lists the open accounts the caller writes with the figure
 * HomeFund derives today, shows each gap before anything is written, and one button counts every account
 * that has a figure, all or nothing. Every figure a test expects is stated here from the rows it seeds.
 *
 * The savings account opens 30 days ago with $ 500.000 and spends $ 20.000, so HomeFund derives $ 480.000;
 * the card opens owing $ 300.000.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const accounts = messages.accounts;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const TODAY = todayInBogota();
const OPENED = addCivilDays(TODAY, -30);
const SPENT = addCivilDays(TODAY, -10);

const SAVINGS_OPENING = 50_000_000;
const SAVINGS_SPEND = 2_000_000;
const SAVINGS_DERIVED = SAVINGS_OPENING - SAVINGS_SPEND; // $ 480.000
const CARD_OPENING = -30_000_000; // owes $ 300.000

const MINUS = "−";

function peso(pesos: number): string {
  return `$ ${Math.abs(pesos).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function flat(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

type Seeded = { id: string; name: string };

async function seed(kind: "asset" | "liability", label: string): Promise<Seeded> {
  const id = randomUUID();
  const name = `Todo ${stamp} ${label}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, settlement_currency)
      values (
        ${id}, ${scope.userId}, ${name}, ${kind}, ${kind === "asset" ? "bank" : "card"},
        ${kind === "asset" ? SAVINGS_OPENING : CARD_OPENING}, ${OPENED}, 'COP')`;

    if (kind === "asset") {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${id}, ${SAVINGS_SPEND}, ${SPENT}, ${`Gasto ${stamp}`})
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, ${SAVINGS_SPEND})`;
    }
  });

  return { id, name };
}

async function drop(account: Seeded): Promise<void> {
  await fixtureSql`
    delete from transactions where from_account_id = ${account.id} or to_account_id = ${account.id}`;
  await fixtureSql`delete from account_reconciliations where account_id = ${account.id}`;
  await fixtureSql`delete from accounts where id = ${account.id}`;
}

async function countsOf(account: Seeded) {
  return fixtureSql<{ counted: string }[]>`
    select counted_balance_cents::text as counted from account_reconciliations where account_id = ${account.id}`;
}

function rowOf(page: Page, account: Seeded): Locator {
  return page.locator(".rt-Card").filter({ hasText: account.name });
}

function figureField(row: Locator, label: string): Locator {
  return row.getByRole("textbox", { name: label, exact: true });
}

function submitLabel(count: number): string {
  return `Cuadrar ${count} ${count === 1 ? "cuenta" : "cuentas"}`;
}

async function open(page: Page): Promise<void> {
  await page.goto("/es/settings/accounts/reconcile");
  await expect(page.getByRole("heading", { name: accounts.reconcileAllTitle, exact: true })).toBeVisible();
}

test.describe("«Cuadrar todo»", () => {
  test("lists each account with its derived figure and age, and Cuentas offers the way in", async ({ page }) => {
    const savings = await seed("asset", "ahorros");
    const card = await seed("liability", "tarjeta");
    try {
      await page.goto("/es/settings/accounts");
      await page.getByRole("link", { name: accounts.reconcileAllOpen, exact: true }).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(/\/settings\/accounts\/reconcile$/);

      const [savingsRow, cardRow] = [rowOf(page, savings), rowOf(page, card)];
      await expect(savingsRow).toContainText(peso(SAVINGS_DERIVED / 100));
      await expect(savingsRow).toContainText(accounts.reconcileAgeNever);
      await expect(figureField(savingsRow, accounts.reconcileAllRealAsset)).toHaveValue("");
      await expect(cardRow).toContainText(peso(-CARD_OPENING / 100));
      await expect(figureField(cardRow, accounts.reconcileAllRealLiability)).toBeVisible();
      await expect(page.getByRole("button", { name: submitLabel(0), exact: true })).toBeDisabled();
      await expect(page.getByText(accounts.reconcileAllNeedOne, { exact: true })).toBeVisible();
    } finally {
      await drop(savings);
      await drop(card);
    }
  });

  test("shows each gap live, works a card's debt out of its limit, and books every count in one go", async ({
    page,
  }) => {
    const savings = await seed("asset", "ahorros");
    const card = await seed("liability", "tarjeta");
    try {
      await open(page);
      const [savingsRow, cardRow] = [rowOf(page, savings), rowOf(page, card)];

      await figureField(savingsRow, accounts.reconcileAllRealAsset).fill("490000");
      expect(flat(await savingsRow.innerText())).toContain(`+${peso(10_000)}`);
      await expect(page.getByRole("button", { name: submitLabel(1), exact: true })).toBeEnabled();

      await cardRow.getByRole("button", { name: accounts.reconcileAllCupoToggle, exact: true }).click();
      await cardRow.getByRole("textbox", { name: accounts.reconcileAllCupoTotal, exact: true }).fill("5000000");
      await cardRow.getByRole("textbox", { name: accounts.reconcileAllCupoAvailable, exact: true }).fill("4800000");
      await expect(figureField(cardRow, accounts.reconcileAllRealLiability)).toHaveValue("200.000");
      expect(flat(await cardRow.innerText())).toContain(`${MINUS}${peso(100_000)}`);

      // Nothing is written until the one button.
      expect(await countsOf(savings)).toEqual([]);
      expect(await countsOf(card)).toEqual([]);

      await page.getByRole("button", { name: submitLabel(2), exact: true }).click();
      await expect(page.getByText("2 cuentas cuadradas", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/accounts$/);

      expect(await countsOf(savings)).toEqual([{ counted: "49000000" }]);
      expect(await countsOf(card)).toEqual([{ counted: "-20000000" }]);
    } finally {
      await drop(savings);
      await drop(card);
    }
  });

  test("says why a figure is refused, flags a sign that opposes the balance, and writes nothing while a figure is wrong", async ({
    page,
  }) => {
    const savings = await seed("asset", "ahorros");
    try {
      await open(page);
      const row = rowOf(page, savings);
      const field = figureField(row, accounts.reconcileAllRealAsset);

      await field.fill("abc");
      await expect(row.getByText(messages.transactions.errors.amountInvalid, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: submitLabel(0), exact: true })).toBeDisabled();

      await field.fill("-200000");
      await expect(row.getByText(accounts.reconcileAllSlip, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: submitLabel(1), exact: true })).toBeEnabled();
      expect(await countsOf(savings)).toEqual([]);
    } finally {
      await drop(savings);
    }
  });

  test("refuses the lot when one account's balance moved, names it and keeps what was typed", async ({ page }) => {
    const savings = await seed("asset", "ahorros");
    const card = await seed("liability", "tarjeta");
    try {
      await open(page);
      await figureField(rowOf(page, card), accounts.reconcileAllRealLiability).fill("250000");
      await figureField(rowOf(page, savings), accounts.reconcileAllRealAsset).fill("480000");

      // A spend lands after the screen read the figures.
      await asHarnessUser(async (tx) => {
        const [movement] = await tx<{ id: string }[]>`
          insert into transactions (from_account_id, amount_cents, occurred_at, description)
          values (${savings.id}, 100000, ${TODAY}, ${`Gasto tarde ${stamp}`})
          returning id`;
        await tx`
          insert into transaction_splits (transaction_id, category_id, amount_cents)
          values (${movement.id}, ${scope.categoryId}, 100000)`;
      });

      await page.getByRole("button", { name: submitLabel(2), exact: true }).click();
      await expect(rowOf(page, savings).getByText(accounts.reconcileAllStale, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/accounts\/reconcile$/);
      await expect(figureField(rowOf(page, card), accounts.reconcileAllRealLiability)).toHaveValue("250.000");
      expect(await countsOf(card)).toEqual([]);
      expect(await countsOf(savings)).toEqual([]);
    } finally {
      await drop(savings);
      await drop(card);
    }
  });
});
