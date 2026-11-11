/**
 * The write forms offer only the accounts the person may write (RF-62, RF-74,
 * RF-29, RF-71, RF-22): «Nuevo pago», the movement form, quick entry and «Nueva
 * regla» cut the list to the person's own accounts and the fund's shared ones,
 * and «Nuevo presupuesto» to every fund account and the person's own. A fellow
 * member's personal account stays readable on the screens that only name it.
 *
 * The plain member drives the forms; the leader's accounts are seeded around
 * them. Every row a test writes is dropped in afterEach, because `purge` refuses
 * while a fund payment names a personal account.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { MEMBER_STORAGE_STATE, asUser, clearGroup, readScope, seedGroup, test } from "./global-setup";
const payments = messages.plannedPayments;
const transactions = messages.transactions;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const LEADER_ACCOUNT = `Zafiro${stamp}`;
const MEMBER_ACCOUNT = `Esmeralda${stamp}`;
const MEMBER_SECOND = `Topacio${stamp}`;
const SHARED_ACCOUNT = `Compartida${stamp}`;
const UNSHARED_ACCOUNT = `Reservada${stamp}`;

const ids = {
  leader: randomUUID(),
  member: randomUUID(),
  memberSecond: randomUUID(),
  shared: randomUUID(),
  unshared: randomUUID(),
};

let groupId = "";

async function seedAccounts() {
  ({ groupId } = await seedGroup());
  await asUser(scope.userId, async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.leader}, ${scope.userId}, ${LEADER_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.shared}, ${groupId}, true, ${SHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01'),
        (${ids.unshared}, ${groupId}, false, ${UNSHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
  });
  await asUser(scope.memberUserId, async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.member}, ${scope.memberUserId}, ${MEMBER_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01'),
        (${ids.memberSecond}, ${scope.memberUserId}, ${MEMBER_SECOND}, 'asset', 'bank', 0, '2026-01-01')`;
  });
}

async function dropRows() {
  const all = Object.values(ids);
  await asUser(scope.userId, async (tx) => {
    await tx`delete from transactions where from_account_id in ${tx(all)} or to_account_id in ${tx(all)}`;
    await tx`delete from recurring_rules where from_account_id in ${tx(all)} or to_account_id in ${tx(all)}`;
    await tx`delete from planned_payments where from_account_id in ${tx(all)} or to_account_id in ${tx(all)}`;
    await tx`delete from budgets where account_id in ${tx(all)}`;
    await tx`delete from accounts where id in ${tx(all)}`;
  });
  await clearGroup();
}

test.beforeEach(async () => {
  await seedAccounts();
});

test.afterEach(async () => {
  await dropRows();
});

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

// What a select offers, read off its open list; the list closes again after.
async function offered(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const names = (await options.allInnerTexts()).map((name) => name.trim());
  await page.keyboard.press("Escape");
  await expect(options.first()).toBeHidden();
  return names;
}

function expectCut(names: string[]) {
  expect(names).toContain(MEMBER_ACCOUNT);
  expect(names).toContain(SHARED_ACCOUNT);
  expect(names).not.toContain(LEADER_ACCOUNT);
  expect(names).not.toContain(scope.accountName);
  expect(names).not.toContain(UNSHARED_ACCOUNT);
}

async function openPayment(page: Page): Promise<Locator> {
  await page.goto("/es/planning/payments");
  await page.getByRole("button", { name: payments.add, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

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

function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

test.describe("as a plain member", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("a payment on the member's own account saves", async ({ page }) => {
    // Kills: every account filtered out.
    const concept = `Pago ${stamp}`;
    const dialog = await openPayment(page);

    await dialog.getByRole("textbox", { name: payments.conceptLabel }).fill(concept);
    await dialog.getByRole("textbox", { name: payments.amountLabel }).fill("25000");
    await choose(page, dialog.locator("#payment-from"), MEMBER_ACCOUNT);
    await dialog.getByLabel(payments.dueLabel).fill("2027-03-12");
    await dialog.getByRole("button", { name: payments.save, exact: true }).click();

    await expect(page.getByText(payments.created, { exact: true })).toBeVisible();
    await expect(band(page).getByText(concept, { exact: true })).toBeVisible();
  });

  test("the movement form cuts both selects and saves a transfer between the member's accounts", async ({
    page,
  }, testInfo) => {
    // Kills: one select cut only.
    const dialog = await openFullForm(page, testInfo);

    expectCut(await offered(page, dialog.locator("#movement-from")));
    expectCut(await offered(page, dialog.locator("#movement-to")));

    await choose(page, dialog.locator("#movement-from"), MEMBER_ACCOUNT);
    await choose(page, dialog.locator("#movement-to"), MEMBER_SECOND);
    await dialog.locator("#movement-amount").fill("30000");
    await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();

    await expect(dialog).toBeHidden();
    const rows = await fixtureSql`select id from transactions where from_account_id = ${ids.member}`;
    expect(rows).toHaveLength(1);
  });
});
