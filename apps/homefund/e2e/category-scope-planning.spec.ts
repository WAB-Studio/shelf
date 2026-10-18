/**
 * A fund category reads `{name} · fondo` wherever planning writes a category
 * name: a budget's card and row, a payment's and a rule's row, and the category
 * select of the three dialogs (RF-140). The person holds a personal category
 * and the fund holds one of the same name; only the mark tells them apart.
 *
 * Every row is written under the harness identity and dropped by id; the group
 * goes through `clearGroup`.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const budgets = messages.budgets;
const payments = messages.plannedPayments;
const rules = messages.recurringRules;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const NAME = `T4 Mercado ${stamp}`;
const MARKED = messages.categories.scopedName.replace("{name}", NAME);
const NAMED_BUDGET = `Comida ${stamp}`;
const PAYMENT = `Pago fondo ${stamp}`;
const RULE = `Regla fondo ${stamp}`;
const PERSONAL_ACCOUNT = `Bancolombia ${stamp}`;
const FUND_ACCOUNT = `Cuenta fondo ${stamp}`;

const ids = {
  fundAccount: randomUUID(),
  personalAccount: randomUUID(),
  personalCategory: randomUUID(),
  fundCategory: randomUUID(),
  fundBudget: randomUUID(),
  namedBudget: randomUUID(),
  personalBudget: randomUUID(),
  payment: randomUUID(),
  rule: randomUUID(),
};

function laptop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 1024;
}

// The laptop's table and the phone's cards both sit in the DOM, cut apart by CSS.
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

function rowMenu(page: Page, title: string): Locator {
  return band(page).getByRole("button", {
    name: common.actionsFor.replace("{name}", title),
    exact: true,
  });
}

test.beforeAll(async () => {
  const { groupId } = await seedGroup();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.fundAccount}, ${groupId}, true, ${FUND_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.personalAccount}, ${scope.userId}, ${PERSONAL_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.personalCategory}, ${scope.userId}, ${NAME}, 'expense', '#4C8C4A')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.fundCategory}, ${groupId}, ${NAME}, 'expense', '#8C4A4A')`;
    await tx`
      insert into budgets (id, group_id, category_id, period, limit_cents, threshold_pct)
      values (${ids.fundBudget}, ${groupId}, ${ids.fundCategory}, 'monthly', 500000, 80)`;
    await tx`
      insert into budgets (id, group_id, category_id, period, limit_cents, threshold_pct, name)
      values (${ids.namedBudget}, ${groupId}, ${ids.fundCategory}, 'monthly', 600000, 80, ${NAMED_BUDGET})`;
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct)
      values (${ids.personalBudget}, ${scope.userId}, ${ids.personalCategory}, 'monthly', 700000, 80)`;
    await tx`
      insert into planned_payments (
        id, group_id, from_account_id, amount_cents, category_id, due_date, description, created_by)
      values (${ids.payment}, ${groupId}, ${ids.fundAccount}, 20000, ${ids.fundCategory},
        current_date, ${PAYMENT}, ${scope.userId})`;
    await tx`
      insert into recurring_rules (
        id, group_id, from_account_id, amount_cents, category_id, description,
        frequency, interval_n, day_of_month, next_run_on, created_by)
      values (${ids.rule}, ${groupId}, ${ids.fundAccount}, 15000, ${ids.fundCategory}, ${RULE},
        'monthly', 1, 5, current_date, ${scope.userId})`;
  });
});

test.afterAll(async () => {
  await fixtureSql`delete from budgets where account_id in ${fixtureSql([ids.fundAccount, ids.personalAccount])}`;
  await fixtureSql`delete from recurring_rules where id = ${ids.rule}`;
  await fixtureSql`delete from planned_payments where id = ${ids.payment}`;
  await fixtureSql`delete from budgets where id in ${fixtureSql([ids.fundBudget, ids.namedBudget, ids.personalBudget])}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.personalCategory, ids.fundCategory])}`;
  await fixtureSql`delete from accounts where id in ${fixtureSql([ids.fundAccount, ids.personalAccount])}`;
  await clearGroup();
});

async function pick(page: Page, trigger: string, option: string) {
  await page.getByRole("dialog").locator(trigger).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("budgets", () => {
  test("a fund budget with no name is titled with the marked category", async ({ page }) => {
    // Kills: the bare map kept in budgets-screen (the card and the row read the bare name), or only one of the two titles marked.
    await page.goto("/es/planning/budgets");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
  });

  test("a named budget keeps its own name", async ({ page }) => {
    // Kills: the category preferred over budget.name.
    await page.goto("/es/planning/budgets");

    await expect(band(page).getByText(NAMED_BUDGET, { exact: true })).toHaveCount(1);
  });

  test("a personal budget reads bare", async ({ page }) => {
    // Kills: every scope marked.
    await page.goto("/es/planning/budgets");

    await expect(band(page).getByText(NAME, { exact: true })).toHaveCount(1);
  });

  test("the new-budget dialog offers both categories apart", async ({ page }) => {
    // Kills: bare names flattened in budget-form-dialog.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await page.getByRole("dialog").getByRole("combobox", { name: budgets.categoryLabel }).click();

    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
  });

  test("a personal account offers only the personal category", async ({ page }) => {
    // Kills: the account ignored by the category list.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await pick(page, "#budget-account", PERSONAL_ACCOUNT);
    await page.getByRole("dialog").getByRole("combobox", { name: budgets.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
  });

  test("the fund's account offers only the fund category", async ({ page }) => {
    // Kills: the filter applied to personal accounts alone.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await pick(page, "#budget-account", FUND_ACCOUNT);
    await page.getByRole("dialog").getByRole("combobox", { name: budgets.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(0);
  });

  test("«Todas las cuentas» offers both again", async ({ page }) => {
    // Kills: the unset account kept as the last scope.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await pick(page, "#budget-account", PERSONAL_ACCOUNT);
    await pick(page, "#budget-account", budgets.accountAny);
    await page.getByRole("dialog").getByRole("combobox", { name: budgets.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
  });

  test("switching to a personal account empties a picked fund category", async ({ page }) => {
    // Kills: a stranded category kept after the account changes.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await pick(page, "#budget-category", MARKED);
    await expect(page.locator("#budget-category")).toHaveText(MARKED);
    await pick(page, "#budget-account", PERSONAL_ACCOUNT);

    await expect(page.locator("#budget-category")).toHaveText("");
  });

  test("a budget on the fund's account and its category saves", async ({ page }) => {
    // A member of a group files every budget under it, so the saving pair is the fund's.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    await pick(page, "#budget-account", FUND_ACCOUNT);
    await pick(page, "#budget-category", MARKED);
    await page.getByRole("dialog").locator("#budget-limit").fill("100000");
    await page.getByRole("dialog").getByRole("button", { name: budgets.save, exact: true }).click();

    await expect(page.getByText(budgets.created, { exact: true })).toBeVisible();
    // The new row would double the marked title the specs below count.
    await fixtureSql`delete from budgets where account_id = ${ids.fundAccount}`;
  });

  test("the edit dialog's locked category reads the marked name", async ({ page }) => {
    // Kills: the locked name read from a bare list.
    await page.goto("/es/planning/budgets");
    await rowMenu(page, MARKED).click();
    await page.getByRole("menuitem", { name: common.edit, exact: true }).click();

    await expect(page.getByRole("dialog").getByText(MARKED, { exact: true })).toBeVisible();
  });
});

test.describe("payments", () => {
  test("the laptop row's category cell reads the marked name", async ({ page }) => {
    // Kills: the bare map kept in payments-screen.
    test.skip(!laptop(page), "the phone's payment row names no category");
    await page.goto("/es/planning/payments");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
  });

  test("the dialog's category select offers both apart", async ({ page }) => {
    // Kills: the bare names at payment-form-dialog's select.
    await page.goto("/es/planning/payments");
    await page.getByRole("button", { name: payments.add, exact: true }).first().click();
    await page.getByRole("dialog").getByRole("combobox", { name: payments.categoryLabel }).click();

    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
  });
});

test.describe("payment categories follow the accounts", () => {
  test("a personal source offers only personal categories", async ({ page }) => {
    // Kills: only toAccountId read.
    await page.goto("/es/planning/payments");
    await page.getByRole("button", { name: payments.add, exact: true }).first().click();
    await pick(page, "#payment-from", PERSONAL_ACCOUNT);
    await page.getByRole("dialog").getByRole("combobox", { name: payments.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
  });

  test("any group account offers only fund categories", async ({ page }) => {
    // Kills: both accounts required to be the group's.
    await page.goto("/es/planning/payments");
    await page.getByRole("button", { name: payments.add, exact: true }).first().click();
    await pick(page, "#payment-from", PERSONAL_ACCOUNT);
    await pick(page, "#payment-to", FUND_ACCOUNT);
    await page.getByRole("dialog").getByRole("combobox", { name: payments.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(0);
  });

  test("switching accounts drops a stranded category", async ({ page }) => {
    // Kills: the picked category kept after its scope left.
    await page.goto("/es/planning/payments");
    await page.getByRole("button", { name: payments.add, exact: true }).first().click();
    await pick(page, "#payment-category", MARKED);
    await pick(page, "#payment-from", PERSONAL_ACCOUNT);

    await expect(page.locator("#payment-category")).toHaveText(payments.categoryNone);
  });
});

test.describe("recurring rules", () => {
  test("the laptop row's category cell reads the marked name", async ({ page }) => {
    // Kills: the bare map kept in recurring-screen.
    test.skip(!laptop(page), "the phone's rule row names no category");
    await page.goto("/es/planning/recurring");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
  });

  test("a rule on the fund account offers its set marked", async ({ page }) => {
    // Kills: the bare lists at recurring-form-dialog.
    test.skip(!laptop(page), "the rule's row menu is the laptop table's");
    await page.goto("/es/planning/recurring");
    await rowMenu(page, RULE).click();
    await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
    await page.getByRole("dialog").getByRole("combobox", { name: rules.categoryLabel }).click();

    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(0);
  });
});
