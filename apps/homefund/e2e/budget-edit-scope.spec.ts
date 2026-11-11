/**
 * «Editar presupuesto» offers only the accounts, and the labels, of the place
 * its category lives in, and the scope refusal reads under its field inside the
 * dialog instead of in a toast that can sit under it at 360 (RF-71, RF-140).
 *
 * The leader and the plain member both drive it. The server's refusal is
 * answered by hand where the form can no longer reach it: the cut lists leave a
 * person no way to pick a pair the trigger refuses.
 *
 * The group, accounts, categories and labels are seeded once and dropped by id;
 * the budgets are rewritten before each test, since a save moves them.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type Route } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const budgets = messages.budgets;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const LEADER_ACCOUNT = `Zafiro ${stamp}`;
const MEMBER_ACCOUNT = `Esmeralda ${stamp}`;
const SHARED_ACCOUNT = `Compartida ${stamp}`;
const UNSHARED_ACCOUNT = `Reservada ${stamp}`;
const LEADER_LABEL = `Etiqueta mia ${stamp}`;
const MEMBER_LABEL = `Etiqueta miembro ${stamp}`;
const FUND_LABEL = `Etiqueta fondo ${stamp}`;
// A fund label reads bare (the user, 2026-10-30): the old suffix is empty.
const FUND_MARK = "";
const LONG_LABEL = `${"Etiqueta larguisima ".repeat(3).slice(0, 52)}${stamp}`;
const LEADER_CATEGORY = `Cat lider ${stamp}`;
const MEMBER_CATEGORY = `Cat miembro ${stamp}`;
const FUND_CATEGORY = `Cat fondo ${stamp}`;
const PERSONAL_BUDGET = `Presupuesto personal ${stamp}`;
const HELD_BUDGET = `Presupuesto con cuenta ${stamp}`;
const FUND_BUDGET = `Presupuesto fondo ${stamp}`;
const MEMBER_BUDGET = `Presupuesto miembro ${stamp}`;
const CREATED = `Presupuesto nuevo ${stamp}`;

const ids = {
  leaderAccount: randomUUID(),
  memberAccount: randomUUID(),
  sharedAccount: randomUUID(),
  strayAccount: randomUUID(),
  unsharedAccount: randomUUID(),
  leaderLabel: randomUUID(),
  memberLabel: randomUUID(),
  fundLabel: randomUUID(),
  longLabel: randomUUID(),
  leaderCategory: randomUUID(),
  memberCategory: randomUUID(),
  fundCategory: randomUUID(),
  personalBudget: randomUUID(),
  heldBudget: randomUUID(),
  strayBudget: randomUUID(),
  fundBudget: randomUUID(),
  memberBudget: randomUUID(),
};

const BUDGET_IDS = [ids.personalBudget, ids.heldBudget, ids.strayBudget, ids.fundBudget, ids.memberBudget];

let groupId = "";

async function insertFundAccounts() {
  await asUser(scope.userId, async (tx) => {
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.sharedAccount}, ${groupId}, true, ${SHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01'),
        (${ids.unsharedAccount}, ${groupId}, false, ${UNSHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
  });
}

test.beforeAll(async () => {
  ({ groupId } = await seedGroup());
  await asUser(scope.userId, async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.leaderAccount}, ${scope.userId}, ${LEADER_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.leaderCategory}, ${scope.userId}, ${LEADER_CATEGORY}, 'expense', '#4C8C4A')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.fundCategory}, ${groupId}, ${FUND_CATEGORY}, 'expense', '#8C4A4A')`;
    await tx`insert into labels (id, owner_user_id, name) values (${ids.leaderLabel}, ${scope.userId}, ${LEADER_LABEL})`;
    await tx`insert into labels (id, group_id, name) values (${ids.fundLabel}, ${groupId}, ${FUND_LABEL})`;
    await tx`insert into labels (id, group_id, name) values (${ids.longLabel}, ${groupId}, ${LONG_LABEL})`;
  });
  await insertFundAccounts();
  await asUser(scope.memberUserId, async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.memberAccount}, ${scope.memberUserId}, ${MEMBER_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.memberCategory}, ${scope.memberUserId}, ${MEMBER_CATEGORY}, 'expense', '#4C8C4A')`;
    await tx`insert into labels (id, owner_user_id, name) values (${ids.memberLabel}, ${scope.memberUserId}, ${MEMBER_LABEL})`;
  });
});

test.beforeEach(async () => {
  await dropBudgets();
  await asUser(scope.userId, async (tx) => {
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name)
      values (${ids.personalBudget}, ${scope.userId}, ${ids.leaderCategory}, 'monthly', 700000, 80, ${PERSONAL_BUDGET})`;
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name, account_id)
      values (${ids.heldBudget}, ${scope.userId}, ${ids.leaderCategory}, 'monthly', 800000, 80, ${HELD_BUDGET}, ${ids.leaderAccount})`;
    await tx`
      insert into budgets (id, group_id, category_id, period, limit_cents, threshold_pct, name)
      values (${ids.fundBudget}, ${groupId}, ${ids.fundCategory}, 'monthly', 500000, 80, ${FUND_BUDGET})`;
  });
  await asUser(scope.memberUserId, async (tx) => {
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name)
      values (${ids.memberBudget}, ${scope.memberUserId}, ${ids.memberCategory}, 'monthly', 400000, 80, ${MEMBER_BUDGET})`;
  });
});

async function dropBudgets() {
  await fixtureSql`delete from budgets where id in ${fixtureSql(BUDGET_IDS)} or name = ${CREATED}`;
}

test.afterAll(async () => {
  await dropBudgets();
  await fixtureSql`delete from labels where id in ${fixtureSql([ids.leaderLabel, ids.memberLabel, ids.fundLabel, ids.longLabel])}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.leaderCategory, ids.memberCategory, ids.fundCategory])}`;
  await fixtureSql`delete from accounts where id in ${fixtureSql([
    ids.leaderAccount,
    ids.memberAccount,
    ids.sharedAccount,
    ids.unsharedAccount,
    ids.strayAccount,
  ])}`;
  await clearGroup();
});

type Row = { limit_cents: string; account_id: string | null; label_id: string | null };

async function rowOf(id: string): Promise<Row> {
  const [row] = await fixtureSql<Row[]>`select limit_cents, account_id, label_id from budgets where id = ${id}`;
  return row;
}

async function openEdit(page: Page, title: string): Promise<Locator> {
  await page.goto("/es/planning/budgets");
  await page
    .getByRole("button", { name: common.actionsFor.replace("{name}", title), exact: true })
    .click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(budgets.categoryLocked)).toBeVisible();
  return dialog;
}

async function openCreate(page: Page): Promise<Locator> {
  await page.goto("/es/planning/budgets");
  await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function pick(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function save(dialog: Locator) {
  await dialog.getByRole("button", { name: budgets.save, exact: true }).click();
}

// Answers every action POST by hand, as the server would have, without sending it.
async function answerActions(page: Page, serverError: string) {
  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "text/x-component",
      body: [
        '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
        `1:${JSON.stringify({ serverError })}`,
        "",
      ].join("\n"),
    });
  });
}

function refusal(dialog: Locator): Locator {
  return dialog.getByRole("alert").filter({ hasText: budgets.errors.scopeViolation });
}

function toasts(page: Page): Locator {
  return page.locator("[data-sonner-toaster]");
}

test.describe("the leader edits", () => {

  test("a personal budget moves to the own account and saves", async ({ page }) => {
    // Kills: every account filtered out; a save that does not reach the row.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await save(dialog);

    await expect(page.getByText(budgets.updated, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    expect((await rowOf(ids.personalBudget)).account_id).toBe(ids.leaderAccount);
  });
});

test.describe("the scope refusal reads on its field", () => {
  test("on edit, a refused label reads under «Etiqueta», the dialog stays open and nothing is written", async ({ page }) => {
    // Kills: the refusal left as a toast.
    const before = await rowOf(ids.personalBudget);
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-label"), LEADER_LABEL);
    await dialog.locator("#budget-limit").fill("123456");
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);

    await expect(refusal(dialog)).toBeVisible();
    await expect(dialog.locator("#budget-label")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#budget-account")).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#budget-limit")).toHaveValue(/123\D?456/);
    await expect(toasts(page).getByText(budgets.errors.scopeViolation)).toHaveCount(0);
    expect(await rowOf(ids.personalBudget)).toEqual(before);

    const label = await dialog.locator("#budget-label").boundingBox();
    const message = await refusal(dialog).boundingBox();
    expect(message!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
  });
});

test.describe("a fund label reads bare", () => {

  test("at 360 px a 60-character label overflows nothing @mobile", async ({ page }) => {
    // Kills: a long marked label widening the dialog or the page.
    expect(LONG_LABEL).toHaveLength(60);
    await page.setViewportSize({ width: 360, height: 740 });
    const dialog = await openCreate(page);
    await pick(page, dialog.locator("#budget-label"), LONG_LABEL + FUND_MARK);

    const trigger = dialog.locator("#budget-label");
    await trigger.scrollIntoViewIfNeeded();
    const page_ = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const inner = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    const box = await trigger.boundingBox();
    expect(page_).toBeLessThanOrEqual(0);
    expect(inner).toBeLessThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);

    await trigger.click();
    const option = page.getByRole("option", { name: LONG_LABEL + FUND_MARK, exact: true });
    await expect(option).toBeVisible();
    const optionBox = await option.boundingBox();
    expect(optionBox!.x + optionBox!.width).toBeLessThanOrEqual(360);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  });
});
