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
import type { TransactionSql } from "postgres";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  MEMBER_STORAGE_STATE,
  claimsFor,
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
const STRAY_ACCOUNT = `Trasladada ${stamp}`;
const SHARED_ACCOUNT = `Compartida ${stamp}`;
const UNSHARED_ACCOUNT = `Reservada ${stamp}`;
const LEADER_LABEL = `Etiqueta mia ${stamp}`;
const MEMBER_LABEL = `Etiqueta miembro ${stamp}`;
const FUND_LABEL = `Etiqueta fondo ${stamp}`;
const FUND_MARK = " · fondo";
const LONG_LABEL = `${"Etiqueta larguisima ".repeat(3).slice(0, 52)}${stamp}`;
const LEADER_CATEGORY = `Cat lider ${stamp}`;
const MEMBER_CATEGORY = `Cat miembro ${stamp}`;
const FUND_CATEGORY = `Cat fondo ${stamp}`;
const PERSONAL_BUDGET = `Presupuesto personal ${stamp}`;
const HELD_BUDGET = `Presupuesto con cuenta ${stamp}`;
const STRAY_BUDGET = `Presupuesto fuera de alcance ${stamp}`;
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

async function as(userId: string, fn: (tx: TransactionSql) => Promise<void>) {
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(userId)}, true)`;
    await fn(tx);
  });
}

async function insertFundAccounts() {
  await as(scope.userId, async (tx) => {
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.sharedAccount}, ${groupId}, true, ${SHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01'),
        (${ids.unsharedAccount}, ${groupId}, false, ${UNSHARED_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
  });
}

test.beforeAll(async () => {
  ({ groupId } = await seedGroup());
  await as(scope.userId, async (tx) => {
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
  await as(scope.memberUserId, async (tx) => {
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
  await as(scope.userId, async (tx) => {
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
  await as(scope.memberUserId, async (tx) => {
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

function expectOnly(names: string[], present: string[], absent: string[]) {
  for (const name of present) expect(names).toContain(name);
  for (const name of absent) expect(names).not.toContain(name);
}

test.describe("the leader edits", () => {
  test("a personal budget offers the leader's own account, never the fund's", async ({ page }) => {
    // Kills: today's filingAccounts, which offers every fund account on a personal budget.
    const dialog = await openEdit(page, PERSONAL_BUDGET);

    const names = await offered(page, dialog.locator("#budget-account"));

    expectOnly(names, [budgets.accountAny, LEADER_ACCOUNT], [SHARED_ACCOUNT, UNSHARED_ACCOUNT, MEMBER_ACCOUNT]);
  });

  test("a fund budget offers both fund accounts, shared and not, never a personal one", async ({ page }) => {
    // Kills: a cut by canWrite, which drops the unshared fund account; today's list, which offers the leader's own.
    const dialog = await openEdit(page, FUND_BUDGET);

    const names = await offered(page, dialog.locator("#budget-account"));

    expectOnly(
      names,
      [budgets.accountAny, SHARED_ACCOUNT, UNSHARED_ACCOUNT],
      [LEADER_ACCOUNT, MEMBER_ACCOUNT, scope.accountName],
    );
  });

  test("a fund with no account leaves only «Todas las cuentas» on a fund budget", async ({ page }) => {
    // Kills: personal accounts offered when the scope holds none.
    await fixtureSql`delete from accounts where id in ${fixtureSql([ids.sharedAccount, ids.unsharedAccount])}`;
    try {
      const dialog = await openEdit(page, FUND_BUDGET);

      const names = await offered(page, dialog.locator("#budget-account"));

      expect(names).toEqual([budgets.accountAny]);
    } finally {
      await insertFundAccounts();
    }
  });

  test("a budget on the leader's own account opens with it in the trigger", async ({ page }) => {
    // Kills: the held account dropped from the list.
    const dialog = await openEdit(page, HELD_BUDGET);

    await expect(dialog.locator("#budget-account")).toHaveText(LEADER_ACCOUNT);
  });

  test("a personal budget saved on a fund account keeps it listed and selected", async ({ page }) => {
    // Kills: the held account dropped from the scoped list when the scope would not offer it.
    // The account joins the fund after the budget is filed on it, which the trigger allows.
    await as(scope.userId, async (tx) => {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${ids.strayAccount}, ${scope.userId}, ${STRAY_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
      await tx`
        insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name, account_id)
        values (${ids.strayBudget}, ${scope.userId}, ${ids.leaderCategory}, 'monthly', 600000, 80, ${STRAY_BUDGET}, ${ids.strayAccount})`;
      await tx`update accounts set owner_user_id = null, group_id = ${groupId} where id = ${ids.strayAccount}`;
    });
    try {
      const dialog = await openEdit(page, STRAY_BUDGET);

      await expect(dialog.locator("#budget-account")).toHaveText(STRAY_ACCOUNT);
      const names = await offered(page, dialog.locator("#budget-account"));
      expectOnly(names, [budgets.accountAny, LEADER_ACCOUNT, STRAY_ACCOUNT], [SHARED_ACCOUNT, UNSHARED_ACCOUNT, MEMBER_ACCOUNT]);
    } finally {
      await dropBudgets();
      await fixtureSql`delete from accounts where id = ${ids.strayAccount}`;
    }
  });

  test("a personal budget moves to the own account and saves", async ({ page }) => {
    // Kills: every account filtered out; a save that does not reach the row.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await save(dialog);

    await expect(page.getByText(budgets.updated, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    expect((await rowOf(ids.personalBudget)).account_id).toBe(ids.leaderAccount);
  });

  test("a fund budget moves to the unshared fund account and saves", async ({ page }) => {
    // Kills: an offered account that does not save; the unshared account dropped.
    const dialog = await openEdit(page, FUND_BUDGET);
    await pick(page, dialog.locator("#budget-account"), UNSHARED_ACCOUNT);
    await save(dialog);

    await expect(page.getByText(budgets.updated, { exact: true })).toBeVisible();
    expect((await rowOf(ids.fundBudget)).account_id).toBe(ids.unsharedAccount);
  });

  test("the labels of a personal budget are the person's, never the fund's", async ({ page }) => {
    // Kills: the label list drawn whole (Q-A a).
    const dialog = await openEdit(page, PERSONAL_BUDGET);

    const names = await offered(page, dialog.locator("#budget-label"));

    expectOnly(names, [budgets.labelAny, LEADER_LABEL], [FUND_LABEL, FUND_LABEL + FUND_MARK]);
  });

  test("the labels of a fund budget are the fund's, never the person's", async ({ page }) => {
    // Kills: the label list cut for personal budgets alone.
    const dialog = await openEdit(page, FUND_BUDGET);

    const names = await offered(page, dialog.locator("#budget-label"));

    expectOnly(names, [budgets.labelAny, FUND_LABEL + FUND_MARK], [FUND_LABEL, LEADER_LABEL, LEADER_LABEL + FUND_MARK]);
  });
});

test.describe("a plain member edits", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("their personal budget offers their own account only", async ({ page }) => {
    // Kills: groupId === null alone, which offers the leader's personal account; today's list with the fund's.
    const dialog = await openEdit(page, MEMBER_BUDGET);

    const names = await offered(page, dialog.locator("#budget-account"));

    expectOnly(
      names,
      [budgets.accountAny, MEMBER_ACCOUNT],
      [LEADER_ACCOUNT, SHARED_ACCOUNT, UNSHARED_ACCOUNT],
    );
  });

  test("a fund budget offers the fund's accounts only", async ({ page }) => {
    // Kills: the member's own account offered on a fund budget.
    const dialog = await openEdit(page, FUND_BUDGET);

    const names = await offered(page, dialog.locator("#budget-account"));

    expectOnly(
      names,
      [budgets.accountAny, SHARED_ACCOUNT, UNSHARED_ACCOUNT],
      [LEADER_ACCOUNT, MEMBER_ACCOUNT],
    );
  });

  test("the leader's budget on the leader's account keeps that account in the trigger", async ({ page }) => {
    // Kills: the held account dropped when the caller cannot write it.
    const dialog = await openEdit(page, HELD_BUDGET);

    await expect(dialog.locator("#budget-account")).toHaveText(LEADER_ACCOUNT);
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
    await expect(dialog.locator("#budget-limit")).toHaveValue("123456");
    await expect(toasts(page).getByText(budgets.errors.scopeViolation)).toHaveCount(0);
    expect(await rowOf(ids.personalBudget)).toEqual(before);

    const label = await dialog.locator("#budget-label").boundingBox();
    const message = await refusal(dialog).boundingBox();
    expect(message!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1);
  });

  test("the message is the topmost thing at its own centre", async ({ page }) => {
    // Kills: the refusal drawn under the dialog (a toast at 360).
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-label"), LEADER_LABEL);
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);
    const message = refusal(dialog);
    await expect(message).toBeVisible();
    await message.scrollIntoViewIfNeeded();

    const covered = await message.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return !top || !node.contains(top);
    });

    expect(covered).toBe(false);
  });

  test("on create, a refused label reads under «Etiqueta» and no row is written", async ({ page }) => {
    // Kills: the refusal routed to a field in the edit hook only.
    const dialog = await openCreate(page);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await pick(page, dialog.locator("#budget-category"), LEADER_CATEGORY);
    await pick(page, dialog.locator("#budget-label"), LEADER_LABEL);
    await dialog.locator("#budget-name").fill(CREATED);
    await dialog.locator("#budget-limit").fill("100000");
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);

    await expect(refusal(dialog)).toBeVisible();
    await expect(dialog.locator("#budget-label")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toBeVisible();
    await expect(toasts(page).getByText(budgets.errors.scopeViolation)).toHaveCount(0);
    expect(await fixtureSql`select id from budgets where name = ${CREATED}`).toHaveLength(0);
  });

  test("with no label picked, the refusal reads under «Cuenta»", async ({ page }) => {
    // Kills: the refusal always routed to the label field.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);

    await expect(refusal(dialog)).toBeVisible();
    await expect(dialog.locator("#budget-account")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#budget-label")).not.toHaveAttribute("aria-invalid", "true");
    const account = await dialog.locator("#budget-account").boundingBox();
    const label = await dialog.locator("#budget-label").boundingBox();
    const message = await refusal(dialog).boundingBox();
    expect(message!.y).toBeGreaterThanOrEqual(account!.y + account!.height - 1);
    expect(message!.y + message!.height).toBeLessThanOrEqual(label!.y + 1);
  });

  test("on create with no label picked, the refusal reads under «Cuenta»", async ({ page }) => {
    // Kills: the create hook routing to the label field regardless of a pick.
    const dialog = await openCreate(page);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await pick(page, dialog.locator("#budget-category"), LEADER_CATEGORY);
    await dialog.locator("#budget-name").fill(CREATED);
    await dialog.locator("#budget-limit").fill("100000");
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);

    await expect(dialog.locator("#budget-account")).toHaveAttribute("aria-invalid", "true");
    await expect(refusal(dialog)).toBeVisible();
  });

  test("any other refusal stays a toast with no field message", async ({ page }) => {
    // Kills: every refusal routed to a field.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await answerActions(page, "errors.notFound");
    await save(dialog);

    await expect(page.getByText(messages.errors.notFound, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.locator("#budget-account")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("after a refusal, an untouched save is not stuck on the old error", async ({ page }) => {
    // Kills: the field error kept sticky across the next submit.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-label"), LEADER_LABEL);
    await answerActions(page, "budgets.errors.scopeViolation");
    await save(dialog);
    await expect(refusal(dialog)).toBeVisible();
    await page.unroute("**/*");

    await pick(page, dialog.locator("#budget-label"), budgets.labelAny);
    await save(dialog);

    await expect(page.getByText(budgets.updated, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    expect((await rowOf(ids.personalBudget)).label_id).toBeNull();
  });
});

test.describe("the create list is cut like the accounts", () => {
  test("a personal account offers only the person's labels", async ({ page }) => {
    // Kills: the create label list drawn whole (Q-A a).
    const dialog = await openCreate(page);
    const all = await offered(page, dialog.locator("#budget-label"));
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);

    const cut = await offered(page, dialog.locator("#budget-label"));

    expectOnly(all, [LEADER_LABEL, FUND_LABEL + FUND_MARK], [FUND_LABEL, LEADER_LABEL + FUND_MARK]);
    expectOnly(cut, [budgets.labelAny, LEADER_LABEL], [FUND_LABEL, FUND_LABEL + FUND_MARK]);
  });

  test("a fund account offers only the fund's labels", async ({ page }) => {
    // Kills: the label cut applied to personal accounts alone.
    const dialog = await openCreate(page);
    await pick(page, dialog.locator("#budget-account"), SHARED_ACCOUNT);

    const names = await offered(page, dialog.locator("#budget-label"));

    expectOnly(names, [budgets.labelAny, FUND_LABEL + FUND_MARK], [FUND_LABEL, LEADER_LABEL, LEADER_LABEL + FUND_MARK]);
  });
});

test.describe("the dialog while it works and when it closes", () => {
  test("while the update is held, the save and every select are disabled", async ({ page }) => {
    // Kills: a pending state that leaves a field editable.
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/*", async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
      await gate;
      await route.continue().catch(() => undefined);
    });
    await save(dialog);

    await expect(dialog.getByRole("button", { name: budgets.save, exact: true })).toBeDisabled();
    await expect(dialog.locator("#budget-account")).toBeDisabled();
    await expect(dialog.locator("#budget-label")).toBeDisabled();
    release();
    await expect(dialog).toBeHidden();
  });

  test("«Cancelar» closes with no request and the row unchanged", async ({ page }) => {
    // Kills: a submit on close.
    const before = await rowOf(ids.personalBudget);
    const dialog = await openEdit(page, PERSONAL_BUDGET);
    await pick(page, dialog.locator("#budget-label"), LEADER_LABEL);
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) posts.push(request.url());
    });
    await dialog.getByRole("button", { name: common.cancel, exact: true }).click();

    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(0);
    expect(await rowOf(ids.personalBudget)).toEqual(before);
  });
});

test.describe("a fund label reads «· fondo»", () => {
  test("on create, every fund label carries the mark and the person's own none", async ({ page }) => {
    // Kills: a fund label offered under its bare name.
    const dialog = await openCreate(page);

    const names = await offered(page, dialog.locator("#budget-label"));

    expectOnly(
      names,
      [LEADER_LABEL, FUND_LABEL + FUND_MARK, LONG_LABEL + FUND_MARK],
      [FUND_LABEL, LONG_LABEL, LEADER_LABEL + FUND_MARK],
    );
  });

  test("on edit, a fund budget's labels carry the mark", async ({ page }) => {
    // Kills: the mark on categories alone.
    const dialog = await openEdit(page, FUND_BUDGET);
    await pick(page, dialog.locator("#budget-label"), FUND_LABEL + FUND_MARK);

    await expect(dialog.locator("#budget-label")).toHaveText(FUND_LABEL + FUND_MARK);
  });

  test("changing the category that clears the picked label stays silent", async ({ page }) => {
    // Kills: a toast or a message when the scope change drops the label.
    const dialog = await openCreate(page);
    await pick(page, dialog.locator("#budget-label"), FUND_LABEL + FUND_MARK);
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);

    await expect(dialog.locator("#budget-label")).toHaveText(budgets.labelAny);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(toasts(page).locator("li")).toHaveCount(0);
  });

  test("at 360 px a 60-character label overflows nothing", async ({ page }) => {
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

test.describe("the Etiqueta list at 360 px", () => {
  test("every option is one line, none prints over the next, and the full name is its name", async ({
    page,
  }) => {
    // Kills: a long fund label wrapping to three lines over «Colegio · fondo».
    await page.setViewportSize({ width: 360, height: 740 });
    const dialog = await openCreate(page);
    await dialog.locator("#budget-label").click();

    const options = page.getByRole("option");
    await expect(page.getByRole("option", { name: LONG_LABEL + FUND_MARK, exact: true })).toBeVisible();
    const boxes = await options.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    const line = Math.min(...boxes.map((b) => b.height));
    for (const [i, box] of boxes.entries()) {
      expect(box.height, `option ${i} is one line`).toBeLessThanOrEqual(line * 1.2);
      expect(box.right).toBeLessThanOrEqual(360);
      if (i > 0) expect(box.top, `option ${i} starts below option ${i - 1}`).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 1);
    }
    // Truncated by the stylesheet, so the DOM still carries the whole name.
    const clipped = await page
      .getByRole("option", { name: LONG_LABEL + FUND_MARK, exact: true })
      .evaluate((el) => {
        return [...el.querySelectorAll<HTMLElement>("*")].some(
          (node) =>
            getComputedStyle(node).textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth,
        );
      });
    expect(clipped).toBe(true);
  });
});

test.describe("a caller with no fund", () => {
  test("edits a personal budget onto the own account and saves", async ({ page }) => {
    // Kills: a missing fund breaking the personal cut.
    await fixtureSql`delete from budgets where id = ${ids.fundBudget}`;
    await clearGroup();
    const dialog = await openEdit(page, PERSONAL_BUDGET);

    const names = await offered(page, dialog.locator("#budget-account"));
    await pick(page, dialog.locator("#budget-account"), LEADER_ACCOUNT);
    await save(dialog);

    expectOnly(names, [budgets.accountAny, LEADER_ACCOUNT], []);
    await expect(page.getByText(budgets.updated, { exact: true })).toBeVisible();
    expect((await rowOf(ids.personalBudget)).account_id).toBe(ids.leaderAccount);
  });
});
