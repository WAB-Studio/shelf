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

import { todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { MEMBER_STORAGE_STATE, asUser, clearGroup, readScope, seedGroup, test } from "./global-setup";

const common = messages.common;
const payments = messages.plannedPayments;
const rules = messages.recurringRules;
const budgets = messages.budgets;
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

  test("a payment offers the member's own account and the shared one, in both selects", async ({ page }) => {
    // Kills: the unfiltered list.
    const dialog = await openPayment(page);

    expectCut(await offered(page, dialog.locator("#payment-from")));
    expectCut(await offered(page, dialog.locator("#payment-to")));
  });

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

  test("an edit keeps naming its account after sharing was turned off", async ({ page }) => {
    // Kills: the held account dropped from the list.
    const concept = `Pago fondo ${stamp}`;
    await asUser(scope.memberUserId, async (tx) => {
      await tx`
        insert into planned_payments (
          group_id, from_account_id, amount_cents, due_date, description, created_by)
        values (${groupId}, ${ids.shared}, 20000, '2027-03-12', ${concept}, ${scope.memberUserId})`;
    });
    await fixtureSql`update accounts set is_shared = false where id = ${ids.shared}`;

    await page.goto("/es/planning/payments");
    await band(page)
      .getByRole("button", { name: common.actionsFor.replace("{name}", concept), exact: true })
      .click();
    await page.getByRole("menuitem", { name: common.edit, exact: true }).click();

    await expect(page.getByRole("dialog").locator("#payment-from")).toHaveText(SHARED_ACCOUNT);
  });

  test("a member with no account of their own and none shared is offered only «Ninguna»", async ({ page }) => {
    // Kills: the unfiltered list.
    await fixtureSql`update accounts set is_shared = false where id = ${ids.shared}`;
    await fixtureSql`delete from accounts where id in ${fixtureSql([ids.member, ids.memberSecond])}`;
    const dialog = await openPayment(page);

    expect(await offered(page, dialog.locator("#payment-from"))).toEqual([payments.accountNone]);
    expect(await offered(page, dialog.locator("#payment-to"))).toEqual([payments.accountNone]);
  });

  test("a payment save held in flight locks the selects and the save button", async ({ page }) => {
    // Kills: a select left live while the POST is out.
    const dialog = await openPayment(page);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/planning/payments", async (route) => {
      if (route.request().method() === "POST") {
        await held;
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await dialog.getByRole("textbox", { name: payments.conceptLabel }).fill(`Pago ${stamp}`);
    await dialog.getByRole("textbox", { name: payments.amountLabel }).fill("25000");
    await choose(page, dialog.locator("#payment-from"), MEMBER_ACCOUNT);
    await dialog.getByLabel(payments.dueLabel).fill("2027-03-12");
    await dialog.getByRole("button", { name: payments.save, exact: true }).click();

    await expect(dialog.locator("#payment-from")).toBeDisabled();
    await expect(dialog.locator("#payment-to")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: payments.save, exact: true })).toBeDisabled();
    release();
  });

  test("cancelling after a pick closes the dialog and writes nothing", async ({ page }) => {
    // Kills: a submit on close.
    let posts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) posts += 1;
    });
    const dialog = await openPayment(page);

    await choose(page, dialog.locator("#payment-from"), MEMBER_ACCOUNT);
    await dialog.getByRole("button", { name: common.cancel, exact: true }).first().click();

    await expect(dialog).toBeHidden();
    expect(posts).toBe(0);
    const rows = await fixtureSql`select id from planned_payments where from_account_id = ${ids.member}`;
    expect(rows).toHaveLength(0);
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

  test("the form opens with no account once the last-used one is no longer on offer", async ({ page }, testInfo) => {
    // Kills: lastUsedAccountId applied unconditionally.
    await asUser(scope.memberUserId, async (tx) => {
      await tx`set local session_replication_role = replica`;
      const [row] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at, created_by, group_id, currency)
        select ${ids.shared}, 10000, ${todayInBogota()}, ${scope.memberUserId}, group_id, settlement_currency
        from accounts where id = ${ids.shared}
        returning id`;
      expect(row.id).toBeTruthy();
    });

    const first = await openFullForm(page, testInfo);
    await expect(first.locator("#movement-to")).toHaveText(SHARED_ACCOUNT);

    await fixtureSql`update accounts set is_shared = false where id = ${ids.shared}`;
    const second = await openFullForm(page, testInfo);

    await expect(second.locator("#movement-to")).toHaveText(transactions.accountNone);
    await expect(second.locator("#movement-from")).toHaveText(transactions.accountNone);
  });

  test("quick entry offers the same cut list", async ({ page }) => {
    // Kills: the filter dropped on the select.
    await page.goto("/es");
    await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
    const sheet = page.getByRole("dialog");

    expectCut(await offered(page, sheet.locator("#quick-account")));
  });

  test("quick entry never reads the leader's account name into the account", async ({ page }) => {
    // Kills: the interpreter fed every account.
    await page.goto("/es");
    await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
    const sheet = page.getByRole("dialog");

    await sheet
      .getByRole("textbox", { name: transactions.quickTitle, exact: true })
      .fill(`20000 mercado ${LEADER_ACCOUNT}`);
    await expect(sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true }).first()).toHaveValue(
      "20000",
    );

    await expect(sheet.locator("#quick-account")).not.toHaveText(LEADER_ACCOUNT);
    await expect(sheet.locator("#quick-account")).toHaveText(transactions.accountLabel);
  });

  test("a rule offers the same cut list", async ({ page }) => {
    // Kills: the filter dropped in the rule dialog.
    await page.goto("/es/planning/recurring");
    await page.getByRole("button", { name: rules.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");

    expectCut(await offered(page, dialog.locator("#rule-account")));
  });

  test("a budget offers every fund account and the member's own, never the leader's", async ({ page }) => {
    // Kills: canWrite alone, which drops the unshared fund account.
    await page.goto("/es/planning/budgets");
    await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");

    const names = await offered(page, dialog.locator("#budget-account"));

    expect(names).toContain(MEMBER_ACCOUNT);
    expect(names).toContain(SHARED_ACCOUNT);
    expect(names).toContain(UNSHARED_ACCOUNT);
    expect(names).not.toContain(LEADER_ACCOUNT);
  });

  test("the filters and the detail still name the leader's personal account", async ({ page }, testInfo) => {
    // Kills: the cut made in the query instead of the pickers.
    await page.goto(`/es/movements?account=${ids.leader}`);
    // The chip sits in both bands, so presence is asserted, not paint.
    await expect(page.getByText(LEADER_ACCOUNT, { exact: true })).not.toHaveCount(0);

    // The phone keeps its filters behind a sheet; the laptop draws the select.
    if (!isDesktop(testInfo)) return;
    await page.goto("/es/movements");
    await page.getByRole("combobox", { name: transactions.accountLabel, exact: true }).first().click();
    await expect(page.getByRole("option", { name: LEADER_ACCOUNT, exact: true })).toHaveCount(1);
  });
});

test.describe("as the leader", () => {
  test("a payment offers the leader's account and never the member's personal one", async ({ page }) => {
    // Kills: a filter by ownerUserId === null.
    const dialog = await openPayment(page);

    const names = await offered(page, dialog.locator("#payment-from"));

    expect(names).toContain(LEADER_ACCOUNT);
    expect(names).toContain(SHARED_ACCOUNT);
    expect(names).not.toContain(MEMBER_ACCOUNT);
  });
});
