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

import { expect, type Browser, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  STORAGE_STATE,
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

// One row menu per budget, named by its whole title: on the phone the fund's card
// splits name and mark into two elements, so the bare name alone cannot count budgets.
function budgetsTitled(page: Page, title: string): Locator {
  return rowMenu(page, title);
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

    await expect(budgetsTitled(page, NAME)).toHaveCount(1);
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

// A budget is filed in the place of the account it names, and with none in the
// place of its category (RF-71, RF-140).
const FORGED = `Presupuesto forjado ${stamp}`;
const SEEDED = [ids.fundBudget, ids.namedBudget, ids.personalBudget];
const memberCategory = randomUUID();

type SavedBudget = { owner_user_id: string | null; group_id: string | null; account_id: string | null };

// Every budget a test of this block wrote: not the three the file seeded.
async function written(categoryId: string): Promise<SavedBudget[]> {
  return fixtureSql<SavedBudget[]>`
    select owner_user_id, group_id, account_id from budgets
    where category_id = ${categoryId} and id not in ${fixtureSql(SEEDED)}`;
}

async function writtenByName(name: string): Promise<number> {
  const rows = await fixtureSql`select id from budgets where name = ${name}`;
  return rows.length;
}

async function saveThroughDialog(page: Page, account: string, category: string) {
  await page.goto("/es/planning/budgets");
  await page.getByRole("button", { name: budgets.add, exact: true }).first().click();
  await pick(page, "#budget-account", account);
  await pick(page, "#budget-category", category);
  await page.getByRole("dialog").locator("#budget-limit").fill("100000");
  await page.getByRole("dialog").getByRole("button", { name: budgets.save, exact: true }).click();
  await expect(page.getByText(budgets.created, { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async () => {
  await fixtureSql`delete from budgets where name = ${FORGED}`;
  await fixtureSql`
    delete from budgets
    where category_id in ${fixtureSql([ids.personalCategory, ids.fundCategory, memberCategory])}
      and id not in ${fixtureSql(SEEDED)}`;
  await fixtureSql`delete from categories where id = ${memberCategory}`;
});

let learnedBudget: { id: string; url: string } | null = null;

// The leader's own save of the fund's pair, caught on the wire for its action id.
async function learnBudgetAction(browser: Browser) {
  if (learnedBudget) return learnedBudget;
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  try {
    const page = await context.newPage();
    const seen: { id: string; url: string }[] = [];
    page.on("request", (request) => {
      const id = request.headers()["next-action"];
      if (request.method() === "POST" && id) seen.push({ id, url: request.url() });
    });
    await saveThroughDialog(page, FUND_ACCOUNT, MARKED);
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    learnedBudget = seen[0];
    return learnedBudget;
  } finally {
    await context.close();
    await fixtureSql`delete from budgets where account_id = ${ids.fundAccount}`;
  }
}

async function forgeBudget(page: Page, action: { id: string; url: string }, input: Record<string, unknown>) {
  const answer = await page.request.post(action.url, {
    headers: {
      "next-action": action.id,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
    },
    data: JSON.stringify([
      { period: "monthly", limit: "100000", thresholdPct: 80, name: FORGED, accountId: null, labelId: null, ...input },
    ]),
  });
  const flight = await answer.text();
  const line = flight.split("\n").find((candidate) => /^\w+:\{"(data|serverError|validationErrors)"/.test(candidate));
  expect(line, "the answer carries no action result").toBeDefined();
  return line ?? "";
}

test.describe("a budget takes the place of its account", () => {
  test("a personal account with a personal category files a personal budget", async ({ page }) => {
    // Kills: the budget filed under the caller's group (the old rule).
    await saveThroughDialog(page, PERSONAL_ACCOUNT, NAME);

    const rows = await written(ids.personalCategory);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBe(scope.userId);
    expect(rows[0].group_id).toBeNull();
    expect(rows[0].account_id).toBe(ids.personalAccount);
    // The seeded personal budget and the new one both title bare; the fund's stays alone marked.
    await page.goto("/es/planning/budgets");
    await expect(budgetsTitled(page, NAME)).toHaveCount(2);
    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
  });

  test("the fund's account with a fund category files the fund's budget", async ({ page }) => {
    // Kills: every budget filed as personal.
    const [{ group_id: fundId }] = await fixtureSql`select group_id from accounts where id = ${ids.fundAccount}`;
    await saveThroughDialog(page, FUND_ACCOUNT, MARKED);

    const rows = await written(ids.fundCategory);
    expect(rows).toHaveLength(1);
    expect(rows[0].group_id).toBe(fundId);
    expect(rows[0].owner_user_id).toBeNull();
    expect(rows[0].account_id).toBe(ids.fundAccount);
  });

  test("«Todas las cuentas» with a personal category files a personal budget", async ({ page }) => {
    // Kills: the account's place used alone, with the group by default.
    await saveThroughDialog(page, budgets.accountAny, NAME);

    const rows = await written(ids.personalCategory);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBe(scope.userId);
    expect(rows[0].group_id).toBeNull();
    expect(rows[0].account_id).toBeNull();
  });

  test("«Todas las cuentas» with a fund category files the fund's budget", async ({ page }) => {
    // Kills: every unset account filed as personal.
    await saveThroughDialog(page, budgets.accountAny, MARKED);

    const rows = await written(ids.fundCategory);
    expect(rows).toHaveLength(1);
    expect(rows[0].group_id).not.toBeNull();
    expect(rows[0].owner_user_id).toBeNull();
  });
});

test.describe("a forged body writes nothing it should not", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "the action is the same at both widths");
  });

  test("a personal account with a fund category is refused by name", async ({ page, browser }) => {
    // Kills: the trigger's 23514 left unmapped.
    const action = await learnBudgetAction(browser);

    const text = await forgeBudget(page, action, {
      categoryId: ids.fundCategory,
      accountId: ids.personalAccount,
    });

    expect(text).toContain("budgets.errors.scopeViolation");
    expect(await writtenByName(FORGED)).toBe(0);
  });

  test("a fellow member's personal category reads as absent", async ({ page, browser }) => {
    // Kills: the budget filed with that member as owner.
    const action = await learnBudgetAction(browser);
    await fixtureSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({
        sub: scope.memberUserId,
        role: "authenticated",
        aud: "authenticated",
      })}, true)`;
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${memberCategory}, ${scope.memberUserId}, ${`Ajena ${stamp}`}, 'expense', '#4C8C4A')`;
    });

    const text = await forgeBudget(page, action, { categoryId: memberCategory });

    expect(text).toContain("errors.notFound");
    expect(await writtenByName(FORGED)).toBe(0);
  });

  test("a category nobody can read reads as absent", async ({ page, browser }) => {
    // Kills: the foreign key left to answer.
    const action = await learnBudgetAction(browser);

    const text = await forgeBudget(page, action, { categoryId: randomUUID() });

    expect(text).toContain("errors.notFound");
    expect(await writtenByName(FORGED)).toBe(0);
  });
});

test.describe("a caller with no fund", () => {
  test("a personal pair files a personal budget", async ({ page }) => {
    // Kills: a missing fund breaking the personal path.
    await clearGroup();
    await saveThroughDialog(page, PERSONAL_ACCOUNT, NAME);

    const rows = await written(ids.personalCategory);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBe(scope.userId);
    expect(rows[0].group_id).toBeNull();
  });
});
