/**
 * The money paths of the movement form, driven in a browser and read back from
 * Postgres: income, transfer, a refused same-account transfer, a split, an
 * unbalanced split, an empty amount, a cancel, the pending state, an edited
 * amount, a delete (and its cancel) and the cash withdrawal.
 *
 * Every expectation below is written from the contract (RF-17, RF-18, RF-24,
 * RF-69, RF-101, RF-68) and from arithmetic done here, never from what the
 * implementation returned: the cents are the pesos typed times a hundred, and a
 * balance is read from the view `getAccountBalances` reads, as the figure the
 * ledger derives (RF-114).
 *
 * The database facts run on the laptop; the phone runs only the 360 px fit of
 * each dialog, the one thing no server-side check reaches.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const common = messages.common;
const cash = messages.cash;

// The contract's text (RF-158), written here so a missing message key fails the test, not the compile.
const RESEND_CHANGED = "Ya guardamos este movimiento con otro monto; ábrelo para corregirlo.";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const SOURCE_NAME = `E9 Banco origen ${stamp}`;
const TARGET_NAME = `E9 Banco destino ${stamp}`;
const CASH_NAME = `E9 Efectivo ${stamp}`;
const INCOME_CATEGORY = `E9 Ingreso ${stamp}`;
const SECOND_EXPENSE_CATEGORY = `E9 Gasto dos ${stamp}`;

// 500 000 pesos and 100 000 pesos, in the cents the ledger stores.
const SOURCE_OPENING = 50_000_000;
const TARGET_OPENING = 10_000_000;

const ids = {
  source: randomUUID(),
  target: randomUUID(),
  cash: randomUUID(),
  incomeCategory: randomUUID(),
  secondExpenseCategory: randomUUID(),
};

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    for (const [id, name, subtype, opening] of [
      [ids.source, SOURCE_NAME, "bank", SOURCE_OPENING],
      [ids.target, TARGET_NAME, "bank", TARGET_OPENING],
    ] as const) {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${name}, 'asset', ${subtype}, ${opening}, '2026-01-01')`;
    }

    // The oldest cash account the caller owns is the one a withdrawal lands on,
    // so this one is dated before any other the lane's earlier specs may have left.
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, created_at)
      values (${ids.cash}, ${scope.userId}, ${CASH_NAME}, 'asset', 'cash', 0, '2026-01-01',
        '1999-01-01T00:00:00Z')`;

    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values
        (${ids.incomeCategory}, ${scope.userId}, ${INCOME_CATEGORY}, 'income', '#4C8C4A'),
        (${ids.secondExpenseCategory}, ${scope.userId}, ${SECOND_EXPENSE_CATEGORY}, 'expense', '#4C8C4A')`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  // Any account a withdrawal created on the way in goes with the rest.
  await fixtureSql`
    delete from accounts
    where owner_user_id = ${scope.userId} and id in ${fixtureSql([ids.source, ids.target, ids.cash])}`;
  await fixtureSql`
    delete from categories where id in ${fixtureSql([ids.incomeCategory, ids.secondExpenseCategory])}`;
});

test.beforeEach(async () => {
  await clearLedger();
});

test.afterEach(async () => {
  await clearLedger();
});

type MovementRow = {
  id: string;
  kind: string;
  amount_cents: string;
  from_account_id: string | null;
  to_account_id: string | null;
  occurred_at: string;
};

async function movements(): Promise<MovementRow[]> {
  return fixtureSql<MovementRow[]>`
    select id, kind, amount_cents::text as amount_cents, from_account_id, to_account_id,
      occurred_at::text as occurred_at
    from transactions
    where owner_user_id = ${scope.userId}
    order by created_at`;
}

async function splitsOf(transactionId: string) {
  return fixtureSql<{ category_id: string; amount_cents: string }[]>`
    select category_id, amount_cents::text as amount_cents
    from transaction_splits
    where transaction_id = ${transactionId}
    order by amount_cents desc`;
}

// The view the balances screen reads: derived from the movements, never stored.
async function balanceOf(accountId: string): Promise<number> {
  const [row] = await fixtureSql<{ balance_cents: string }[]>`
    select balance_cents::text as balance_cents
    from account_balances
    where id = ${accountId} and currency = 'COP'`;
  return Number(row.balance_cents);
}

async function seedExpense(options: {
  amountCents: number;
  description: string;
}): Promise<string> {
  let id = "";
  await asHarnessUser(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${ids.source}, ${options.amountCents},
        (now() at time zone ${TIME_ZONE})::date, ${options.description})
      returning id`;
    id = row.id;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${id}, ${scope.categoryId}, ${options.amountCents})`;
  });
  return id;
}

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

// The dashboard's two ways into the full form: the laptop draws a button of its
// own beside the quick-entry row, the phone reaches it through the quick sheet.
async function openFullForm(page: Page, testInfo: TestInfo, reload = true): Promise<Locator> {
  if (reload) await page.goto("/es");
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

const field = (dialog: Locator, id: string) => dialog.locator(`#${id}`);

async function fillAccounts(
  page: Page,
  dialog: Locator,
  accounts: { from: string | null; to: string | null },
) {
  await choose(page, field(dialog, "movement-from"), accounts.from ?? transactions.accountNone);
  await choose(page, field(dialog, "movement-to"), accounts.to ?? transactions.accountNone);
}

const saveButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: transactions.saveMovement, exact: true });

// The chevron that leaves the form is the one control named «Cancelar».
const cancelButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: common.cancel, exact: true });

// One category is a tile of the grid; «Más» shows the rest of the catalogue.
async function pickCategory(dialog: Locator, name: string) {
  const tile = dialog.getByRole("button", { name, exact: true });
  const more = dialog.getByRole("button", { name: transactions.categoryMore, exact: true });
  await expect(tile.or(more).first()).toBeVisible();
  if (!(await tile.isVisible())) await more.click();
  await tile.click();
}

// Splitting across several categories sits behind «Dividir».
const divide = (dialog: Locator) =>
  dialog.getByRole("button", { name: transactions.splitDivide, exact: true }).click();

const splitCategory = (dialog: Locator, position: number) =>
  dialog.getByRole("combobox", {
    name: transactions.splitRowCategory.replace("{position}", String(position)),
    exact: true,
  });

const splitAmount = (dialog: Locator, position: number) =>
  dialog.getByRole("textbox", {
    name: transactions.splitRowAmount.replace("{position}", String(position)),
    exact: true,
  });

// Every server action the page posts, counted as it leaves the browser.
function countActionPosts(page: Page): () => number {
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) posts += 1;
  });
  return () => posts;
}

test.describe("on the laptop", () => {
  test.skip(({ viewport }) => viewport?.width === 360, "the database facts are read once, on the laptop");

  test("an income names only a destination, and 1 234 567,89 is stored as 123456789 cents with one split", async ({
    page,
  }, testInfo) => {
    // Kills: the amount multiplied by a hundred a second time before it is written.
    const before = await balanceOf(ids.source);
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: null, to: SOURCE_NAME });
    await field(dialog, "movement-amount").fill("1 234 567,89");
    await pickCategory(dialog, INCOME_CATEGORY);

    // The kind is read off the accounts and shown, never chosen (RF-18).
    await expect(dialog.getByText(transactions.kindIncome, { exact: true })).toBeVisible();

    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("income");
    expect(rows[0].amount_cents).toBe("123456789");
    expect(rows[0].from_account_id).toBeNull();
    expect(rows[0].to_account_id).toBe(ids.source);

    const splits = await splitsOf(rows[0].id);
    expect(splits).toEqual([{ category_id: ids.incomeCategory, amount_cents: "123456789" }]);

    expect(await balanceOf(ids.source)).toBe(before + 123_456_789);
  });

  test("a transfer between two accounts is a transfer with both legs, no split, and both balances move", async ({
    page,
  }, testInfo) => {
    // Kills: the movement written with one of its two legs only.
    const [sourceBefore, targetBefore] = [await balanceOf(ids.source), await balanceOf(ids.target)];
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: TARGET_NAME });
    await field(dialog, "movement-amount").fill("30000");

    await expect(dialog.getByText(transactions.kindTransfer, { exact: true })).toBeVisible();
    // A transfer carries no category (RF-69): the editor is not even on the form.
    await expect(dialog.getByRole("button", { name: transactions.splitDivide, exact: true })).toHaveCount(0);

    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("transfer");
    expect(rows[0].amount_cents).toBe("3000000");
    expect(rows[0].from_account_id).toBe(ids.source);
    expect(rows[0].to_account_id).toBe(ids.target);
    expect(await splitsOf(rows[0].id)).toEqual([]);

    expect(await balanceOf(ids.source)).toBe(sourceBefore - 3_000_000);
    expect(await balanceOf(ids.target)).toBe(targetBefore + 3_000_000);
  });

  test("the same account on both sides is refused with its message and writes nothing", async ({
    page,
  }, testInfo) => {
    // Kills: the schema that no longer compares the two accounts (RF-101).
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: SOURCE_NAME });
    await field(dialog, "movement-amount").fill("1000");
    await saveButton(dialog).click();

    await expect(dialog.getByText(messages.transactions.errors.accountSame, { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(await movements()).toEqual([]);
  });

  test("an expense split in two, 30 000 and 20 000, stores two splits that sum to the 50 000 amount", async ({
    page,
  }, testInfo) => {
    // Kills: only the first split row reaching the database.
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await field(dialog, "movement-amount").fill("50000");
    await pickCategory(dialog, scope.categoryName);
    await divide(dialog);

    // A lone split holds the whole amount and cannot be edited away from it, so
    // the second row goes in before the first one is narrowed.
    await dialog.getByRole("button", { name: transactions.splitAddCategory, exact: true }).click();
    await choose(page, splitCategory(dialog, 2), SECOND_EXPENSE_CATEGORY);
    await splitAmount(dialog, 1).fill("30000");
    await splitAmount(dialog, 2).fill("20000");

    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("expense");
    expect(rows[0].amount_cents).toBe("5000000");

    expect(await splitsOf(rows[0].id)).toEqual([
      { category_id: scope.categoryId, amount_cents: "3000000" },
      { category_id: ids.secondExpenseCategory, amount_cents: "2000000" },
    ]);
  });

  test("splits that leave 10 000 unassigned are refused on the form and write nothing", async ({
    page,
  }, testInfo) => {
    // Kills: the sum rule dropped from the form's schema, so the short split goes to the server.
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await field(dialog, "movement-amount").fill("50000");
    await pickCategory(dialog, scope.categoryName);
    await divide(dialog);

    // A lone split holds the whole amount and cannot be edited away from it, so
    // the second row goes in before the first one is narrowed.
    await dialog.getByRole("button", { name: transactions.splitAddCategory, exact: true }).click();
    await choose(page, splitCategory(dialog, 2), SECOND_EXPENSE_CATEGORY);
    await splitAmount(dialog, 1).fill("30000");
    await splitAmount(dialog, 2).fill("10000");

    const posts = countActionPosts(page);
    await saveButton(dialog).click();

    await expect(dialog.getByText(messages.transactions.errors.splitsSumMismatch, { exact: true })).toBeVisible();
    expect(posts()).toBe(0);
    expect(await movements()).toEqual([]);
  });

  test("an empty amount says so under the field and posts no action", async ({ page }, testInfo) => {
    // Kills: the form's resolver removed, so an empty amount is sent to the server.
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await pickCategory(dialog, scope.categoryName);

    const posts = countActionPosts(page);
    await saveButton(dialog).click();

    await expect(dialog.getByText(messages.transactions.errors.amountRequired, { exact: true })).toBeVisible();
    expect(posts()).toBe(0);
    expect(await movements()).toEqual([]);
  });

  test("«Cancelar» after typing closes the form and writes nothing", async ({ page }, testInfo) => {
    // Kills: leaving the form submitting what was typed.
    const dialog = await openFullForm(page, testInfo);

    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await field(dialog, "movement-amount").fill("9999");
    await pickCategory(dialog, scope.categoryName);

    const posts = countActionPosts(page);
    await cancelButton(dialog).click();

    await expect(dialog).toBeHidden();
    // Nothing was posted at the moment of leaving, and nothing lands afterwards.
    expect(posts()).toBe(0);
    await page.waitForLoadState("networkidle");
    expect(await movements()).toEqual([]);
  });

  test.describe("while the save is in flight", () => {
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

    test("the save button reads as busy and cannot be pressed a second time", async ({ page }, testInfo) => {
      // Kills: the save button left enabled while the action runs, so a double tap writes twice.
      const dialog = await openFullForm(page, testInfo);
      await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
      await field(dialog, "movement-amount").fill("4000");
      await pickCategory(dialog, scope.categoryName);

      await saveButton(dialog).click();

      await expect(saveButton(dialog)).toBeDisabled();
      release();
      await expect(dialog).toBeHidden();
      expect(await movements()).toHaveLength(1);
    });

    test("«Cancelar» cannot be pressed either, so the form is not left while the money is being written", async ({
      page,
    }, testInfo) => {
      // Kills: the way out left enabled while the action runs.
      const dialog = await openFullForm(page, testInfo);
      await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
      await field(dialog, "movement-amount").fill("4000");
      await pickCategory(dialog, scope.categoryName);

      await saveButton(dialog).click();

      await expect(saveButton(dialog)).toBeDisabled();
      await expect(cancelButton(dialog)).toBeDisabled();
      release();
      await expect(dialog).toBeHidden();
    });
  });

  test("editing 15 000 into 27 000 stores 2 700 000 cents and the list shows the new figure", async ({
    page,
  }) => {
    // Kills: the update that ignores the amount it was given.
    const description = `E9 editar ${stamp}`;
    const id = await seedExpense({ amountCents: 1_500_000, description });

    await page.goto(`/es/movements/${id}`);
    await page.getByRole("button", { name: transactions.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await field(dialog, "movement-amount").fill("27000");
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("2700000");
    // The lone split follows the amount, so the ledger still sums (RF-69).
    expect(await splitsOf(id)).toEqual([{ category_id: scope.categoryId, amount_cents: "2700000" }]);

    await page.goto("/es/movements");
    const row = page.getByRole("table", { name: transactions.listTitle }).getByRole("row").filter({ hasText: description });
    await expect(row).toContainText("27.000");
    await expect(row).not.toContainText("15.000");
  });

  test("deleting a movement removes the row and puts the balance back where it was", async ({ page }) => {
    // Kills: a delete that answers success and leaves the row in the ledger.
    const before = await balanceOf(ids.source);
    const id = await seedExpense({ amountCents: 1_500_000, description: `E9 borrar ${stamp}` });
    expect(await balanceOf(ids.source)).toBe(before - 1_500_000);

    await page.goto(`/es/movements/${id}`);
    await page.getByRole("button", { name: transactions.delete, exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.getByRole("button", { name: transactions.delete, exact: true }).click();

    await expect(page).toHaveURL(/\/es\/movements$/);
    expect(await movements()).toEqual([]);
    expect(await balanceOf(ids.source)).toBe(before);
  });

  test("«Cancelar» in the delete confirmation keeps the movement", async ({ page }) => {
    // Kills: the cancel button that confirms.
    const before = await balanceOf(ids.source);
    const id = await seedExpense({ amountCents: 1_500_000, description: `E9 conservar ${stamp}` });

    await page.goto(`/es/movements/${id}`);
    await page.getByRole("button", { name: transactions.delete, exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText(transactions.deleteTitle, { exact: true })).toBeVisible();
    await confirm.getByRole("button", { name: common.cancel, exact: true }).click();

    await expect(confirm).toBeHidden();
    await page.waitForLoadState("networkidle");
    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(await balanceOf(ids.source)).toBe(before - 1_500_000);
  });

  test("withdrawing 100 000 from the bank is one transfer into the caller's cash: 10 000 000 cents on both legs", async ({
    page,
  }) => {
    // Kills: the withdrawal written with only its source leg.
    const [bankBefore, cashBefore] = [await balanceOf(ids.source), await balanceOf(ids.cash)];

    await page.goto("/es");
    await page.getByRole("button", { name: cash.withdrawAction, exact: true }).filter({ visible: true }).click();
    await choose(page, page.locator("#withdraw-source"), SOURCE_NAME);
    await expect(page.getByText(CASH_NAME, { exact: true })).toBeVisible();
    await page.locator("#withdraw-amount").fill("100000");
    await page.getByRole("button", { name: cash.withdrawSave, exact: true }).filter({ visible: true }).click();

    await expect(page.getByText(cash.withdrawSaved, { exact: true })).toBeVisible();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("transfer");
    expect(rows[0].amount_cents).toBe("10000000");
    expect(rows[0].from_account_id).toBe(ids.source);
    expect(rows[0].to_account_id).toBe(ids.cash);
    expect(await splitsOf(rows[0].id)).toEqual([]);

    expect(await balanceOf(ids.source)).toBe(bankBefore - 10_000_000);
    expect(await balanceOf(ids.cash)).toBe(cashBefore + 10_000_000);
  });
});

test.describe("at 360 px", () => {
  test.skip(({ viewport }) => viewport?.width !== 360, "the phone runs only the fit of each dialog");

  // A dialog fits when its box sits inside the viewport and the page grew no
  // sideways scroll to hold it.
  async function expectFits(page: Page, surface: Locator) {
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test("the movement form fits the phone, its save button inside the screen", async ({ page }, testInfo) => {
    // Kills: the two-column body kept below the breakpoint, which pushes the dialog past 360.
    const dialog = await openFullForm(page, testInfo);
    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });

    await expectFits(page, dialog);
    const save = await saveButton(dialog).boundingBox();
    expect(save!.x).toBeGreaterThanOrEqual(0);
    expect(save!.x + save!.width).toBeLessThanOrEqual(360);
  });

  test("the withdrawal dialog fits the phone", async ({ page }) => {
    // Kills: a fixed width on the withdrawal dialog.
    await page.goto("/es");
    await page.getByRole("button", { name: cash.withdrawAction, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: cash.withdrawTitle })).toBeVisible();

    await expectFits(page, dialog);
  });

  test("the delete confirmation fits the phone", async ({ page }) => {
    // Kills: a fixed width on the confirmation dialog.
    const id = await seedExpense({ amountCents: 1_500_000, description: `E9 confirmar ${stamp}` });
    await page.goto(`/es/movements/${id}`);
    await page.getByRole("button", { name: transactions.delete, exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();

    await expectFits(page, confirm);
  });
});

// A save whose answer never reached the browser (RNF-10): the server ran the
// first POST, the browser saw it fail, and the person presses save again.
test.describe("a resent save and a stale edit", () => {
  test.skip(({ viewport }) => viewport?.width === 360, "the database facts are read once, on the laptop");

  test("a save whose answer was lost, saved again, leaves exactly one movement", async ({ page }, testInfo) => {
    // Kills: a new request ref minted on every click, so the resend writes a second row.
    let dropped = 0;
    await page.route(
      (url) => url.pathname.startsWith("/es"),
      async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] && dropped === 0) {
          dropped += 1;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );

    const dialog = await openFullForm(page, testInfo);
    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await field(dialog, "movement-amount").fill("4000");
    await pickCategory(dialog, scope.categoryName);

    await saveButton(dialog).click();
    await expect.poll(() => dropped).toBe(1);
    // The server ran it; the person never heard.
    await expect.poll(async () => (await movements()).length).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(saveButton(dialog)).toBeEnabled();

    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("400000");
    expect(await splitsOf(rows[0].id)).toHaveLength(1);
  });

  test("a save whose answer was lost, saved again with another amount, shows the refusal and keeps the first amount", async ({ page }, testInfo) => {
    // Kills: a resend answered ok whatever the amount, so the form closes over a figure never saved.
    let dropped = 0;
    await page.route(
      (url) => url.pathname.startsWith("/es"),
      async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] && dropped === 0) {
          dropped += 1;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );

    const dialog = await openFullForm(page, testInfo);
    await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
    await field(dialog, "movement-amount").fill("4000");
    await pickCategory(dialog, scope.categoryName);

    await saveButton(dialog).click();
    await expect.poll(() => dropped).toBe(1);
    await expect.poll(async () => (await movements()).length).toBe(1);
    await expect(saveButton(dialog)).toBeEnabled();

    await field(dialog, "movement-amount").fill("9000");
    await saveButton(dialog).click();

    await expect(dialog.getByText(RESEND_CHANGED, { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(field(dialog, "movement-amount")).toHaveValue(/9\D?000/);
    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("400000");
  });

  test("two separate openings, saved once each, leave two movements", async ({ page }, testInfo) => {
    // Kills: a request ref that outlives its opening, so the second save answers the first movement.
    // The page is not reloaded between them: a ref held by the module would survive.
    await page.goto("/es");
    for (const amount of ["4000", "5000"]) {
      const dialog = await openFullForm(page, testInfo, false);
      await fillAccounts(page, dialog, { from: SOURCE_NAME, to: null });
      await field(dialog, "movement-amount").fill(amount);
      await pickCategory(dialog, scope.categoryName);
      await saveButton(dialog).click();
      await expect(dialog).toBeHidden();
    }

    const rows = await movements();
    expect(rows.map((row) => row.amount_cents).sort()).toEqual(["400000", "500000"]);
  });

  test("a stale edit keeps the form open with what was typed, shows the refusal and writes nothing", async ({
    page,
    context,
  }) => {
    // Kills: the stale answer ignored, so the form closes over the other tab's change.
    const id = await seedExpense({ amountCents: 1_500_000, description: `E9 vencido ${stamp}` });
    const other = await context.newPage();

    const openEdit = async (tab: Page) => {
      await tab.goto(`/es/movements/${id}`);
      await tab.getByRole("button", { name: transactions.edit, exact: true }).click();
      return tab.getByRole("dialog");
    };
    const dialogA = await openEdit(page);
    const dialogB = await openEdit(other);

    await field(dialogA, "movement-amount").fill("27000");

    await field(dialogB, "movement-amount").fill("31000");
    await saveButton(dialogB).click();
    await expect(dialogB).toBeHidden();
    expect((await movements())[0].amount_cents).toBe("3100000");

    await saveButton(dialogA).click();

    await expect(dialogA.getByText(messages.errors.stale, { exact: true })).toBeVisible();
    await expect(dialogA).toBeVisible();
    await expect(field(dialogA, "movement-amount")).toHaveValue(/^27\D?000$/);
    await expect(saveButton(dialogA)).toBeEnabled();
    // The other tab's figure stands.
    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("3100000");
    await other.close();
  });

  test("an edit nobody else touched saves, even after the form was open for a while", async ({ page }) => {
    // Kills: an expected stamp that never matches, so every ordinary edit is refused.
    const id = await seedExpense({ amountCents: 1_500_000, description: `E9 vigente ${stamp}` });
    await page.goto(`/es/movements/${id}`);
    await page.getByRole("button", { name: transactions.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await field(dialog, "movement-amount").fill("18000");
    await saveButton(dialog).click();
    await expect(dialog).toBeHidden();
    expect((await movements())[0].amount_cents).toBe("1800000");
  });
});

// A withdrawal whose answer never reached the browser (RNF-10, Q24): the server moved
// the money, the browser saw the request fail, and the person presses save again.
test.describe("a cash withdrawal sent again", () => {
  test.skip(({ viewport }) => viewport?.width === 360, "the laptop's button sits beside quick entry; the phone's keeps its own");

  const save = (page: Page) =>
    page.getByRole("button", { name: cash.withdrawSave, exact: true }).filter({ visible: true });

  test("a withdrawal whose answer was lost, saved again, moves the money once", async ({ page }) => {
    // Kills: a new request ref per click, or none sent, so the resend is a second transfer.
    let dropped = 0;
    await page.route(
      (url) => url.pathname.startsWith("/es"),
      async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] && dropped === 0) {
          dropped += 1;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );
    const bankBefore = await balanceOf(ids.source);

    await page.goto("/es");
    await page.getByRole("button", { name: cash.withdrawAction, exact: true }).filter({ visible: true }).click();
    await choose(page, page.locator("#withdraw-source"), SOURCE_NAME);
    await page.locator("#withdraw-amount").fill("100000");
    await save(page).click();
    await expect.poll(() => dropped).toBe(1);
    await expect.poll(async () => (await movements()).length).toBe(1);
    await expect(save(page)).toBeEnabled();

    await save(page).click();
    await expect(page.getByText(cash.withdrawSaved, { exact: true })).toBeVisible();

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("10000000");
    expect(await balanceOf(ids.source)).toBe(bankBefore - 10_000_000);
  });

  test("two withdrawals one after the other, without reloading, are two transfers", async ({ page }) => {
    // Kills: a request ref that outlives its attempt, so the second withdrawal answers the first.
    await page.goto("/es");
    for (const amount of ["100000", "50000"]) {
      await page.getByRole("button", { name: cash.withdrawAction, exact: true }).filter({ visible: true }).click();
    await choose(page, page.locator("#withdraw-source"), SOURCE_NAME);
      await page.locator("#withdraw-amount").fill(amount);
      await save(page).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    const rows = await movements();
    expect(rows.map((row) => row.amount_cents).sort()).toEqual(["10000000", "5000000"]);
  });
});
