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

import { expect, type Page } from "@playwright/test";

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

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const NAME = `T4 Mercado ${stamp}`;
// A fund category reads bare now (the user, 2026-10-30), so the fixture gives it a name of its own
// to tell the two scopes apart.
const MARKED = `${NAME} del fondo`;
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
      values (${ids.fundCategory}, ${groupId}, ${MARKED}, 'expense', '#8C4A4A')`;
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
});

// A budget is filed in the place of the account it names, and with none in the
// place of its category (RF-71, RF-140).
const FORGED = `Presupuesto forjado ${stamp}`;
const SEEDED = [ids.fundBudget, ids.namedBudget, ids.personalBudget];
const memberCategory = randomUUID();

test.afterEach(async () => {
  await fixtureSql`delete from budgets where name = ${FORGED}`;
  await fixtureSql`
    delete from budgets
    where category_id in ${fixtureSql([ids.personalCategory, ids.fundCategory, memberCategory])}
      and id not in ${fixtureSql(SEEDED)}`;
  await fixtureSql`delete from categories where id = ${memberCategory}`;
});
