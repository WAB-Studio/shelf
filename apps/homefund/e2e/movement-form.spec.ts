/**
 * The one movement form (RF-272 to RF-277): three tabs that keep what was typed, an edit that opens on the
 * movement's own tab, the split's words, the pocket notice and its undo, the draft kept when there is no
 * account yet, and a transfer named in a person's words in the list.
 *
 * Every expectation is arithmetic done here: pesos typed times a hundred are the cents stored.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, MEMBER_STORAGE_STATE, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const MAIN_NAME = `F1 Ahorros ${stamp}`;
const OTHER_NAME = `F1 Efectivo ${stamp}`;
const POCKET_NAME = `F1 Viajes ${stamp}`;
const LOAN_NAME = `F1 Crédito Lulo ${stamp}`;
const SECOND_CATEGORY = `F1 Gasto dos ${stamp}`;
const INCOME_CATEGORY = `F1 Ingreso ${stamp}`;

const ids = {
  main: randomUUID(),
  other: randomUUID(),
  pocket: randomUUID(),
  loan: randomUUID(),
  secondCategory: randomUUID(),
  incomeCategory: randomUUID(),
};

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    // 100 000 pesos free in the main account, 500 000 in its pocket.
    for (const [id, name, subtype, kind, opening] of [
      [ids.main, MAIN_NAME, "bank", "asset", 10_000_000],
      [ids.other, OTHER_NAME, "cash", "asset", 0],
      [ids.loan, LOAN_NAME, "loan", "liability", 0],
    ] as const) {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, institution, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${name}, ${kind}, ${subtype},
          ${subtype === "loan" ? "Lulo" : null}, ${opening}, '2026-01-01')`;
    }
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, parent_account_id)
      values (${ids.pocket}, ${scope.userId}, ${POCKET_NAME}, 'asset', 'bank', 50_000_000, '2026-01-01', ${ids.main})`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values
        (${ids.secondCategory}, ${scope.userId}, ${SECOND_CATEGORY}, 'expense', '#4C8C4A'),
        (${ids.incomeCategory}, ${scope.userId}, ${INCOME_CATEGORY}, 'income', '#4C8C4A')`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`
    delete from accounts
    where owner_user_id = ${scope.userId}
      and id in ${fixtureSql([ids.pocket, ids.main, ids.other, ids.loan])}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.secondCategory, ids.incomeCategory])}`;
});

test.beforeEach(async () => {
  await clearLedger();
});

test.afterEach(async () => {
  await clearLedger();
});

async function openForm(page: Page): Promise<Locator> {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("form").getByRole("heading", { name: transactions.formTitle })).toBeVisible();
  return dialog;
}

const tab = (dialog: Locator, name: string) => dialog.getByRole("radio", { name, exact: true });
const words = (dialog: Locator) => dialog.locator("#movement-description");
const amountField = (dialog: Locator) => dialog.locator("#movement-amount");
const dateField = (dialog: Locator) => dialog.locator("#movement-date");

async function choose(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

const splitAmount = (dialog: Locator, position: number) =>
  dialog.getByRole("textbox", {
    name: transactions.splitRowAmount.replace("{position}", String(position)),
    exact: true,
  });

async function rows() {
  return fixtureSql<
    { id: string; kind: string; amount_cents: string; occurred_at: string; description: string | null }[]
  >`
    select id, kind, amount_cents::text as amount_cents, occurred_at::text as occurred_at, description
    from transactions where owner_user_id = ${scope.userId} order by created_at`;
}

test("the three tabs keep the amount, the words and the date", async ({ page }) => {
  const dialog = await openForm(page);

  await words(dialog).fill("Cena con amigos");
  await amountField(dialog).fill("45000");
  await dateField(dialog).fill("10/11/2026");

  for (const name of [transactions.kindIncome, transactions.kindTransfer, transactions.kindExpense]) {
    await tab(dialog, name).click();
    await expect(tab(dialog, name)).toBeChecked();
    await expect(words(dialog)).toHaveValue("Cena con amigos");
    await expect(amountField(dialog)).toHaveValue("45.000");
    await expect(dateField(dialog)).toHaveValue("10/11/2026");
  }

  // No word of the model reaches the form.
  const text = (await dialog.innerText()).toLowerCase();
  expect(text).not.toContain("origen");
  expect(text).not.toContain("destino");
  expect(text).not.toContain("traspaso");
});

test("an income is written from its tab with the words as typed, less the figure the field took", async ({ page }) => {
  const dialog = await openForm(page);
  await tab(dialog, transactions.kindIncome).click();
  await words(dialog).fill("Pago de Ana 80.000");
  await expect(amountField(dialog)).toHaveValue("80.000");
  await choose(page, dialog.locator("#movement-to"), MAIN_NAME);
  await dialog.getByRole("button", { name: INCOME_CATEGORY, exact: true }).click();
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();

  const [saved] = await rows();
  expect([saved.kind, saved.amount_cents, saved.description]).toEqual(["income", "8000000", "Pago de Ana"]);
});

test("a transfer is written from its tab, and one side alone is refused", async ({ page }) => {
  const dialog = await openForm(page);
  await tab(dialog, transactions.kindTransfer).click();
  await amountField(dialog).fill("30000");
  await choose(page, dialog.locator("#movement-from"), MAIN_NAME);

  // Without the account it goes into, nothing is written as an expense by accident.
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog.getByText(transactions.errors.transferNeedsTarget)).toBeVisible();
  expect(await rows()).toHaveLength(0);

  await choose(page, dialog.locator("#movement-to"), OTHER_NAME);
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();

  expect((await rows()).map((row) => [row.kind, row.amount_cents])).toEqual([["transfer", "3000000"]]);
});

test("«uber 38.000 ayer» keeps the words in the field, reads the day and the figure, saves what is left as the description and proposes no wrong category", async ({
  page,
}) => {
  const dialog = await openForm(page);
  await words(dialog).fill("compra rara 38.000 ayer");

  await expect(amountField(dialog)).toHaveValue("38.000");
  await expect(dateField(dialog)).not.toHaveValue("");
  await expect(words(dialog)).toHaveValue("compra rara 38.000 ayer");

  await choose(page, dialog.locator("#movement-from"), MAIN_NAME);
  await dialog.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();

  const [saved] = await rows();
  expect(saved.description).toBe("compra rara");
  expect(saved.amount_cents).toBe("3800000");
  const yesterday = await fixtureSql<{ day: string }[]>`
    select ((now() at time zone 'America/Bogota')::date - 1)::text as day`;
  expect(saved.occurred_at).toBe(yesterday[0].day);
});

test("«12.000.50» asks which figure was meant and waits for the answer", async ({ page }) => {
  const dialog = await openForm(page);
  await words(dialog).fill("mercado 12.000.50");

  const question = "¿Quisiste decir 12.000,50 o 1.200.050?";
  await expect(dialog.getByText(question, { exact: true })).toBeVisible();
  await expect(amountField(dialog)).toHaveValue("");

  await dialog.getByRole("radio", { name: /1\.200\.050/ }).check();
  await expect(amountField(dialog)).toHaveValue("1.200.050");
});

test("editing opens the same form on the movement's own tab", async ({ page }) => {
  const [transfer] = await fixtureSql<{ id: string }[]>`
    insert into transactions (owner_user_id, created_by, from_account_id, to_account_id, amount_cents, occurred_at, description)
    values (${scope.userId}, ${scope.userId}, ${ids.main}, ${ids.other}, 2000000, (now() at time zone 'America/Bogota')::date, 'Retiro del mes')
    returning id`;

  await page.goto(`/es/movements/${transfer.id}`);
  await page.getByRole("button", { name: transactions.edit, exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");

  await expect(tab(dialog, transactions.kindTransfer)).toBeChecked();
  await expect(words(dialog)).toHaveValue("Retiro del mes");
  await expect(dialog.locator("#movement-from")).toContainText(MAIN_NAME);
  await expect(dialog.locator("#movement-to")).toContainText(OTHER_NAME);

  await amountField(dialog).fill("25000");
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await rows())[0].amount_cents).toBe("2500000");
});

test("a split says «Falta asignar» when short and «Te pasaste» when over, and its first line is editable", async ({
  page,
}) => {
  const dialog = await openForm(page);
  await amountField(dialog).fill("50000");
  await choose(page, dialog.locator("#movement-from"), MAIN_NAME);
  await dialog.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await dialog.getByRole("button", { name: transactions.splitDivide, exact: true }).click();

  // The lone line is the person's to edit: it stays at what was typed.
  await splitAmount(dialog, 1).fill("30000");
  await expect(splitAmount(dialog, 1)).toHaveValue("30.000");
  await expect(dialog.getByRole("status").filter({ hasText: transactions.splitMissing })).toContainText("20.000");

  await dialog.getByRole("button", { name: transactions.splitAddCategory, exact: true }).click();
  await choose(
    page,
    dialog.getByRole("combobox", { name: transactions.splitRowCategory.replace("{position}", "2"), exact: true }),
    SECOND_CATEGORY,
  );
  await splitAmount(dialog, 2).fill("30000");
  await expect(dialog.getByRole("status").filter({ hasText: transactions.splitOver })).toContainText("10.000");

  await splitAmount(dialog, 2).fill("20000");
  await expect(dialog.getByRole("status").filter({ hasText: transactions.splitDone })).toBeVisible();
});

test("an expense past what is free says which pocket it will draw from, and «Deshacer» gives it back", async ({
  page,
}) => {
  const dialog = await openForm(page);
  await amountField(dialog).fill("150000");
  await choose(page, dialog.locator("#movement-from"), MAIN_NAME);

  // 100 000 are free, so 50 000 come from the pocket (RF-249).
  const notice = dialog.getByRole("status").filter({ hasText: POCKET_NAME });
  await expect(notice).toContainText(/Se tomarán .*50\.000 de /);

  // A smaller expense draws nothing and says nothing.
  await amountField(dialog).fill("90000");
  await expect(notice).toHaveCount(0);

  await amountField(dialog).fill("150000");
  await dialog.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();

  expect(await rows()).toHaveLength(2);
  await page.getByRole("button", { name: transactions.undo, exact: true }).click();
  await expect.poll(async () => (await rows()).length).toBe(0);
});

test("a card purchase takes «a 12 cuotas» from the words and defers it", async ({ page }) => {
  const cardId = randomUUID();
  const CARD_NAME = `F1 Visa ${stamp}`;
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${cardId}, ${scope.userId}, ${CARD_NAME}, 'liability', 'card', 0, '2026-01-01')`;
  });
  try {
    const dialog = await openForm(page);
    await choose(page, dialog.locator("#movement-from"), CARD_NAME);
    await words(dialog).fill("nevera 2.400.000 a 12 cuotas");
    await expect(dialog.locator("#movement-instalments")).toHaveValue("12");
    await dialog.getByRole("button", { name: scope.categoryName, exact: true }).click();
    await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const [deferred] = await fixtureSql<{ instalments: number }[]>`
          select d.instalments from deferrals d join transactions t on t.id = d.transaction_id
          where t.owner_user_id = ${scope.userId}`;
        return deferred?.instalments ?? 0;
      })
      .toBe(12);

    // The instalments and the figure went to their fields; only the thing bought is the description.
    const saved = await rows();
    expect(saved.map((row) => row.description)).toEqual(["nevera"]);
  } finally {
    await clearLedger();
    await fixtureSql`delete from accounts where id = ${cardId}`;
  }
});

test("paying a card past what is free says which pocket it will draw from, and «Deshacer» gives it back", async ({
  page,
}) => {
  const cardId = randomUUID();
  const CARD_NAME = `F1 Visa pago ${stamp}`;
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${cardId}, ${scope.userId}, ${CARD_NAME}, 'liability', 'card', -30_000_000, '2026-01-01')`;
    await tx`
      insert into debt_terms (
        account_id, debt_kind, annual_rate, minimum_payment_cents,
        credit_limit_cents, statement_cut_off_day, payment_due_day)
      values (${cardId}, 'revolving', 0.28, 500_000, 80_000_000, 15, 28)`;
  });
  const paid = () =>
    fixtureSql<{ id: string }[]>`select id from transactions where to_account_id = ${cardId}`;
  try {
    await page.goto(`/es/planning/debts/${cardId}`);
    await page.getByRole("button", { name: messages.debts.rowPayCard, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(messages.installments.fromLabel).click();
    await page.getByRole("option", { name: MAIN_NAME, exact: true }).click();

    // 100 000 are free in the main account, so 150 000 take 50 000 from the pocket (RF-249, RF-276).
    await dialog.getByRole("textbox", { name: messages.installments.amountLabel }).fill("150000");
    await expect(dialog.getByRole("status").filter({ hasText: POCKET_NAME })).toContainText(/Se tomarán .*50\.000 de /);

    // A payment the free part covers draws nothing and says nothing.
    await dialog.getByRole("textbox", { name: messages.installments.amountLabel }).fill("90000");
    await expect(dialog.getByRole("status").filter({ hasText: POCKET_NAME })).toHaveCount(0);
    await expect(dialog.getByRole("status").filter({ hasText: "quedaría en" })).toHaveCount(0);

    // Past the free part and the pocket together, the account would end below zero: said before saving.
    await dialog.getByRole("textbox", { name: messages.installments.amountLabel }).fill("700000");
    await expect(dialog.getByRole("status").filter({ hasText: "quedaría en" })).toContainText(
      new RegExp(`${MAIN_NAME} quedaría en .*100\\.000`),
    );

    await dialog.getByRole("textbox", { name: messages.installments.amountLabel }).fill("150000");
    await dialog.getByRole("button", { name: messages.installments.paymentSave, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await paid()).length).toBe(1);
    await page.getByRole("button", { name: transactions.undo, exact: true }).click();
    await expect.poll(async () => (await paid()).length).toBe(0);
  } finally {
    await clearLedger();
    await fixtureSql`delete from accounts where id = ${cardId}`;
  }
});

test("a transfer into a loan reads «Pago cuota <crédito>» in Movimientos and in its detail", async ({ page }) => {
  const [paid] = await fixtureSql<{ id: string }[]>`
    insert into transactions (owner_user_id, created_by, from_account_id, to_account_id, amount_cents, occurred_at)
    values (${scope.userId}, ${scope.userId}, ${ids.main}, ${ids.loan}, 7800000, (now() at time zone 'America/Bogota')::date)
    returning id`;
  const title = transactions.transferLoanPayment.replace("{name}", "Lulo");

  await page.goto("/es/movements");
  await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  expect(await page.locator("main").innerText()).not.toContain(`${MAIN_NAME} → ${LOAN_NAME}`);

  await page.goto(`/es/movements/${paid.id}`);
  await expect(page.getByText(title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test.describe("with no account yet", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE, viewport: { width: 1280, height: 800 } });

  test("saving offers «Crear cuenta» and keeps what was typed, never «Elige al menos una cuenta»", async ({
    page,
  }) => {
    await page.goto("/es");
    await page.getByRole("button", { name: messages.nav.record, exact: true }).click();
    const dialog = page.getByRole("dialog");

    await words(dialog).fill("almuerzo 25 mil");
    await expect(amountField(dialog)).toHaveValue("25.000");
    await expect(dialog.getByText(transactions.noAccounts)).toBeVisible();

    await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
    await expect(page.getByRole("dialog").filter({ hasText: messages.accounts.addTitle })).toBeVisible();
    await expect(page.getByText(/Elige al menos una cuenta/)).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(words(dialog)).toHaveValue("almuerzo 25 mil");
    await expect(amountField(dialog)).toHaveValue("25.000");
  });
});

test("the words «uber 38.000 ayer» save «uber» as the description, with the day and the figure in their fields", async ({
  page,
}) => {
  const dialog = await openForm(page);
  await choose(page, dialog.locator("#movement-from"), MAIN_NAME);
  await words(dialog).fill("uber 38.000 ayer");
  await expect(amountField(dialog)).toHaveValue("38.000");
  await dialog.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();

  const [row] = await rows();
  expect([row.description, row.amount_cents]).toEqual(["uber", "3800000"]);
});

// «Pagar» in «Lo que viene» says what the movement form says: the pocket it draws from and, when even that does not
// cover it, that the account would end below zero. The person may still confirm.
test.describe("«Pagar» in «Lo que viene»", () => {
  const description = `Matrícula ${stamp}`;
  const pay = messages.upcoming.act.pay;

  async function plan(pesos: number) {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into planned_payments (owner_user_id, from_account_id, amount_cents, category_id, due_date, description, created_by)
        values (${scope.userId}, ${ids.main}, ${pesos * 100}, ${scope.categoryId}, (now() at time zone 'America/Bogota')::date,
          ${description}, ${scope.userId})`;
    });
  }

  async function openPay(page: Page): Promise<Locator> {
    await page.goto("/es/planning/upcoming");
    const card = page.locator(".rt-Card").filter({ hasText: description }).filter({ visible: true });
    await card.getByRole("button", { name: pay, exact: true }).click();
    return page.getByRole("dialog");
  }

  test.afterEach(async () => {
    await fixtureSql`delete from planned_payments where description = ${description}`;
  });

  test("past what is free it names the pocket, and «Deshacer» gives the payment back", async ({ page }) => {
    await plan(150000);
    const dialog = await openPay(page);

    await expect(dialog.getByRole("status").filter({ hasText: POCKET_NAME })).toContainText(/Se tomarán .*50\.000 de /);
    await expect(dialog.getByRole("status").filter({ hasText: "quedaría en" })).toHaveCount(0);

    await dialog.getByRole("button", { name: pay, exact: true }).click();
    await expect(dialog).toBeHidden();
    const status = () =>
      fixtureSql<{ status: string }[]>`select status from planned_payments where description = ${description}`;
    await expect.poll(async () => (await status())[0].status).toBe("done");

    await page.getByRole("button", { name: transactions.undo, exact: true }).click();
    await expect.poll(async () => (await status())[0].status).toBe("pending");
    expect(await rows()).toHaveLength(0);
  });

  test("past the free part and the pocket together it says the account would end below zero, and still saves", async ({
    page,
  }) => {
    await plan(700000);
    const dialog = await openPay(page);

    await expect(dialog.getByRole("status").filter({ hasText: "quedaría en" })).toContainText(
      new RegExp(`${MAIN_NAME} quedaría en .*100\\.000`),
    );

    await dialog.getByRole("button", { name: pay, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await fixtureSql<{ status: string }[]>`select status from planned_payments where description = ${description}`)[0].status)
      .toBe("done");
  });
});
