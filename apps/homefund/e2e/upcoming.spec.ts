/**
 * «Lo que viene» (RF-290, RF-291, RF-292): one list ordered by date that holds the payments, the expected
 * incomes and the rules that repeat; one «Agregar» form that asks «¿Pagas o recibes?» and «¿Una vez o se
 * repite?»; «Ya llegó» on an expected income; «Saltar» on a rule; and the three old routes sending the person
 * here.
 *
 * Written from the contract, not from the components: the words on a row are the ones the user decided.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const copy = messages.upcoming;

test.use({ viewport: { width: 1280, height: 900 } });

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const incomeCategory = randomUUID();
const today = todayInBogota();

async function clearPlans() {
  await fixtureSql`delete from planned_payments where owner_user_id = ${scope.userId}`;
  await fixtureSql`delete from recurring_rules where owner_user_id = ${scope.userId}`;
}

test.beforeEach(async () => {
  await clearPlans();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${incomeCategory}, ${scope.userId}, ${`Ingreso ${stamp}`}, 'income', '#4C8C4A')`;
  });
});

test.afterEach(async () => {
  await clearPlans();
  await fixtureSql`delete from transactions where created_by = ${scope.userId} and description like ${`%${stamp}%`}`;
  await fixtureSql`delete from categories where id = ${incomeCategory}`;
});

const card = (page: Page, text: string): Locator =>
  page.locator(".rt-Card").filter({ hasText: text }).filter({ visible: true });

async function seedPayment(description: string, due: string, kind: "payment" | "income") {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into planned_payments (owner_user_id, from_account_id, to_account_id, amount_cents, due_date, description, created_by)
      values (${scope.userId}, ${kind === "payment" ? scope.accountId : null}, ${kind === "income" ? scope.accountId : null},
        2500000, ${due}, ${description}, ${scope.userId})`;
  });
}

async function seedRule(description: string, next: string) {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into recurring_rules (
        owner_user_id, from_account_id, amount_cents, category_id, description, frequency, interval_n,
        day_of_month, next_run_on, created_by)
      values (${scope.userId}, ${scope.accountId}, 1500000, ${scope.categoryId}, ${description}, 'weekly', 1,
        null, ${next}, ${scope.userId})`;
  });
}

async function choose(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("the list holds every kind in date order, each row saying what it is and offering one action", async ({
  page,
}) => {
  // Kills: separate lists per kind, a list ordered by kind, a row that does not name what it is.
  const income = `Cliente ${stamp}`;
  const payment = `Arriendo ${stamp}`;
  const rule = `Gimnasio ${stamp}`;
  await seedRule(rule, addCivilDays(today, 20));
  await seedPayment(payment, addCivilDays(today, 10), "payment");
  await seedPayment(income, addCivilDays(today, 5), "income");

  await page.goto("/es/planning/upcoming");
  await expect(page.getByRole("heading", { name: copy.title, level: 1 })).toBeVisible();

  const order = (await page.locator(".rt-Card").filter({ visible: true }).allInnerTexts()).map((text) =>
    [income, payment, rule].findIndex((name) => text.includes(name)),
  );
  expect(order.filter((index) => index >= 0)).toEqual([0, 1, 2]);

  await expect(card(page, income)).toContainText(copy.kind.income);
  await expect(card(page, income).getByRole("button", { name: copy.act.arrived, exact: true })).toBeVisible();
  await expect(card(page, payment)).toContainText(copy.kind.payment);
  await expect(card(page, payment)).toContainText(scope.accountName);
  await expect(card(page, payment).getByRole("button", { name: copy.act.pay, exact: true })).toBeVisible();
  await expect(card(page, rule)).toContainText("Se repite cada semana");
  await expect(card(page, rule).getByRole("button", { name: copy.act.skip.weekly, exact: true })).toBeVisible();
});

test("with nothing coming, the screen says what to add and shows no section", async ({ page }) => {
  await page.goto("/es/planning/upcoming");

  await expect(page.getByText(copy.emptyTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(copy.emptyDescription, { exact: true })).toBeVisible();
  await expect(page.locator(".rt-Card").filter({ visible: true })).toHaveCount(0);
});

test("one «Agregar» form adds a payment, an income, a rule and a repeating income", async ({ page }) => {
  // Kills: a form that cannot reach one of the four writes, or one that writes the wrong kind.
  await page.goto("/es/planning/upcoming");

  async function add(
    { receives, repeats, name, date, category }: { receives: boolean; repeats: boolean; name: string; date: string; category?: string },
  ) {
    await page.getByRole("button", { name: copy.add, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(copy.form.directionLabel, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.form.repeatLabel, { exact: true })).toBeVisible();
    if (receives) await dialog.getByRole("radio", { name: copy.form.receive, exact: true }).click();
    if (repeats) await dialog.getByRole("radio", { name: copy.form.repeats, exact: true }).click();

    await dialog
      .getByRole("textbox", { name: receives ? copy.form.conceptReceive : copy.form.conceptPay })
      .fill(name);
    await dialog.getByRole("textbox", { name: copy.form.amount }).fill("25000");
    await choose(page, dialog.locator("#upcoming-account"), scope.accountName);
    await dialog
      .getByLabel(repeats ? copy.form.dateRepeat : receives ? copy.form.dateReceive : copy.form.datePay)
      .fill(date);
    if (category) await choose(page, dialog.locator("#upcoming-category"), category);
    await dialog.getByRole("button", { name: copy.form.save, exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(card(page, name)).toHaveCount(1);
  }

  const year = Number(today.slice(0, 4)) + 1;
  const names = {
    pay: `Pago ${stamp}`,
    receive: `Ingreso de ${stamp}`,
    repeatPay: `Cada mes ${stamp}`,
    repeatReceive: `Sueldo ${stamp}`,
  };
  await add({ receives: false, repeats: false, name: names.pay, date: `${year}-03-12` });
  await add({ receives: true, repeats: false, name: names.receive, date: `${year}-03-13` });
  await add({ receives: false, repeats: true, name: names.repeatPay, date: `${year}-03-14`, category: scope.categoryName });
  await add({ receives: true, repeats: true, name: names.repeatReceive, date: `${year}-03-15`, category: `Ingreso ${stamp}` });

  await expect(card(page, names.pay)).toContainText(copy.kind.payment);
  await expect(card(page, names.receive)).toContainText(copy.kind.income);
  await expect(card(page, names.repeatPay)).toContainText("Se repite cada mes");
  await expect(card(page, names.repeatReceive)).toContainText("Se repite cada mes");

  const planned = await fixtureSql<{ description: string; from_account_id: string | null; to_account_id: string | null; amount_cents: string }[]>`
    select description, from_account_id, to_account_id, amount_cents::text from planned_payments
    where owner_user_id = ${scope.userId} order by description`;
  expect(planned.map((row) => [row.description, row.from_account_id !== null, row.to_account_id !== null, row.amount_cents])).toEqual([
    [names.receive, false, true, "2500000"],
    [names.pay, true, false, "2500000"],
  ]);

  const rules = await fixtureSql<{ description: string; from_account_id: string | null; to_account_id: string | null; day_of_month: number; frequency: string }[]>`
    select description, from_account_id, to_account_id, day_of_month, frequency from recurring_rules
    where owner_user_id = ${scope.userId}`;
  expect(rules).toHaveLength(2);
  const expense = rules.find((row) => row.description === names.repeatPay);
  const earning = rules.find((row) => row.description === names.repeatReceive);
  expect([expense?.from_account_id !== null, expense?.to_account_id, expense?.day_of_month, expense?.frequency]).toEqual([true, null, 14, "monthly"]);
  expect([earning?.from_account_id, earning?.to_account_id !== null, earning?.day_of_month]).toEqual([null, true, 15]);
});

test("«Ya llegó» books the income, and the row leaves the list", async ({ page }) => {
  // Kills: an action that only hides the row, or one that books an expense.
  const from = `Proyecto ${stamp}`;
  await seedPayment(from, addCivilDays(today, -2), "income");

  await page.goto("/es/planning/upcoming");
  await expect(card(page, from)).toContainText(copy.late.income);
  await card(page, from).getByRole("button", { name: copy.act.arrived, exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: copy.settle.incomeTitle })).toBeVisible();
  // An expected income carries no category, and an income is never booked without one: the dialog asks for it.
  await dialog.getByRole("button", { name: copy.act.arrived, exact: true }).click();
  await expect(dialog.getByText(messages.plannedPayments.errors.settleNeedsCategory, { exact: true })).toBeVisible();
  await choose(page, dialog.locator("#settle-category"), `Ingreso ${stamp}`);
  await dialog.getByRole("button", { name: copy.act.arrived, exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(card(page, from)).toHaveCount(0);
  const [row] = await fixtureSql<{ status: string; settled_transaction_id: string | null; to_account_id: string | null; from_account_id: string | null }[]>`
    select p.status, p.settled_transaction_id, t.to_account_id, t.from_account_id
    from planned_payments p left join transactions t on t.id = p.settled_transaction_id
    where p.owner_user_id = ${scope.userId} and p.description = ${from}`;
  expect(row.status).toBe("done");
  expect(row.settled_transaction_id).not.toBeNull();
  expect([row.from_account_id, row.to_account_id]).toEqual([null, scope.accountId]);
});

test("«Saltar esta semana» moves a rule one period on without booking anything", async ({ page }) => {
  // Kills: a skip that books the movement, or one that leaves the date where it was.
  const rule = `Clase ${stamp}`;
  const next = addCivilDays(today, 3);
  await seedRule(rule, next);

  await page.goto("/es/planning/upcoming");
  await card(page, rule).getByRole("button", { name: copy.act.skip.weekly, exact: true }).click();

  await expect
    .poll(async () => {
      const [row] = await fixtureSql<{ next_run_on: string }[]>`
        select next_run_on::text from recurring_rules where owner_user_id = ${scope.userId} and description = ${rule}`;
      return row.next_run_on;
    })
    .toBe(addCivilDays(next, 7));
  const booked = await fixtureSql`select id from transactions where created_by = ${scope.userId} and description = ${rule}`;
  expect(booked).toHaveLength(0);
});

test("«Saltar esta semana» offers «Deshacer», which gives the run back", async ({ page }) => {
  // Kills: a skip with no way back, which moved the rent a month on without a word.
  const rule = `Clase deshacer ${stamp}`;
  const next = addCivilDays(today, 3);
  await seedRule(rule, next);
  const nextRun = async () =>
    (await fixtureSql<{ next_run_on: string }[]>`
      select next_run_on::text from recurring_rules where owner_user_id = ${scope.userId} and description = ${rule}`)[0]
      .next_run_on;

  await page.goto("/es/planning/upcoming");
  await card(page, rule).getByRole("button", { name: copy.act.skip.weekly, exact: true }).click();
  await expect.poll(nextRun).toBe(addCivilDays(next, 7));

  await page.getByRole("button", { name: messages.transactions.undo, exact: true }).click();
  await expect.poll(nextRun).toBe(next);
});

test("a repeating plan asks for a category and never offers «Sin categoría»", async ({ page }) => {
  // Kills: a placeholder that offers what the server then refuses.
  await page.goto("/es/planning/upcoming");
  await page.getByRole("button", { name: copy.add, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: copy.form.repeats, exact: true }).click();

  await expect(dialog.locator("#upcoming-category")).not.toContainText(copy.form.categoryNone);
  await expect(dialog.locator("#upcoming-category")).toContainText(copy.form.categoryPlaceholder);
});

for (const old of ["payments", "recurring", "subscriptions"]) {
  test(`the old /planning/${old} address lands on «Lo que viene»`, async ({ page }) => {
    await page.goto(`/es/planning/${old}`);

    await expect(page).toHaveURL("/es/planning/upcoming");
    await expect(page.getByRole("heading", { name: copy.title, level: 1 })).toBeVisible();
  });
}
