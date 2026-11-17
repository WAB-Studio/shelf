/**
 * A loan's figures are the bank's (RF-300, RF-301) and a debt can begin earlier from the place that refused a day
 * (RF-303): two payments of the whole cuota leave two rows paid and the loan at the schedule's capital, what the payer
 * owes is that capital in the credit's section, Cuentas' «Te deben» and nowhere is a cuota called short; a purchase
 * dated before a new debt began offers «Cambiar a <fecha>» in place and saves with one tap.
 *
 * Every expectation is arithmetic done here: pesos typed times a hundred are the cents stored.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";
import { addCivilDays, todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const today = todayInBogota();

const ids = { loan: randomUUID(), bank: randomUUID(), receivable: randomUUID(), card: randomUUID(), fresh: randomUUID() };
const FRESH_NAME = `L1 Ahorros nuevo ${stamp}`;
const LOAN_NAME = `L1 Crédito Lulo ${stamp}`;
const BANK_NAME = `L1 Ahorros ${stamp}`;
const CARD_NAME = `L1 Tarjeta nueva ${stamp}`;
const PAYER = "John";

// The report's loan, in cents: 5.000.000 owed and three cuotas, the second one asking less interest than the first.
const dueOn = [addCivilDays(today, -31), addCivilDays(today, -1), addCivilDays(today, 29)];
const SCHEDULE = [
  { principal: 23_121_100, interest: 10_558_200, total: 33_679_300, remaining: 476_878_900 },
  { principal: 23_609_300, interest: 10_070_000, total: 33_679_300, remaining: 453_269_600 },
  { principal: 453_269_600, interest: 9_571_400, total: 462_841_000, remaining: 0 },
];

// «dd/mm/aaaa», the way the date field is typed.
const typed = (day: string) => day.split("-").reverse().join("/");

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const opening = addCivilDays(today, -60);
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.loan}, ${scope.userId}, ${LOAN_NAME}, 'liability', 'loan', ${-500_000_000}, ${opening}),
        (${ids.bank}, ${scope.userId}, ${BANK_NAME}, 'asset', 'bank', ${900_000_000}, ${opening}),
        (${ids.receivable}, ${scope.userId}, ${`Me debe ${PAYER} ${stamp}`}, 'asset', 'receivable', ${486_948_900}, ${addCivilDays(today, -46)})`;
    for (const [index, row] of SCHEDULE.entries()) {
      await tx`
        insert into loan_schedule_rows (account_id, number, due_on, principal_cents, interest_cents, insurance_cents, total_cents, remaining_cents)
        values (${ids.loan}, ${index + 1}, ${dueOn[index]}, ${row.principal}, ${row.interest}, 0, ${row.total}, ${row.remaining})`;
    }
    await tx`
      insert into third_party_credits (liability_account_id, receivable_account_id, person_name)
      values (${ids.loan}, ${ids.receivable}, ${PAYER})`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`delete from third_party_credits where liability_account_id = ${ids.loan}`;
  await fixtureSql`
    delete from accounts
    where owner_user_id = ${scope.userId} and (id in ${fixtureSql([ids.loan, ids.bank, ids.receivable, ids.fresh])} or name = ${CARD_NAME})`;
});

test("two whole cuotas leave two rows paid, the capital where the schedule says and the payer owing exactly that", async ({
  page,
}) => {
  await page.goto(`/es/planning/debts/${ids.loan}`);
  const main = page.getByRole("main");

  for (const on of dueOn.slice(0, 2)) {
    await main.getByRole("button", { name: messages.debts.rowPayLoan, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(messages.installments.fromLabel).click();
    await page.getByRole("option", { name: BANK_NAME, exact: true }).click();
    // The amount opens at what the next cuota asks, interest and capital together.
    await expect(dialog.getByRole("textbox", { name: messages.installments.amountLabel })).toHaveValue(/336\.793|336,793/);
    await dialog.getByLabel(messages.installments.dateLabel).fill(typed(on));
    await dialog.getByRole("button", { name: messages.installments.paymentSave, exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  // One cuota left, with its interest: 462.841.000 cents, 4.628.410 pesos; the two paid rows are paid, none is partial.
  await expect(main.getByText(/^Falta pagar .*4\.628\.410 en 1 cuota$/)).toBeVisible();
  await expect(main.getByText(messages.loanSchedule.statePaid, { exact: true })).toHaveCount(2);
  await expect(main.getByText(/Parcial · faltan/)).toHaveCount(0);

  const [loan] = await fixtureSql<{ balance: string }[]>`
    select balance_cents::text as balance from account_balances where id = ${ids.loan}`;
  expect(loan.balance).toBe(String(-SCHEDULE[1].remaining));

  await main.getByRole("button", { name: messages.loanStanding.open }).click();
  await expect(page.getByRole("dialog").getByText("2 de 3", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // What the payer owes is the capital the bank says is left, in this section, and the figure never goes below it.
  await expect(main.getByText(messages.thirdPartyCredit.personOwes.replace("{person}", PAYER), { exact: true })).toBeVisible();
  await expect(main.getByText(/4\.532\.696/).first()).toBeVisible();

  // Cuentas' «Te deben» says the same figure, with the cuotas' interest apart.
  await page.goto("/es/settings/accounts");
  const owed = page.getByRole("region", { name: messages.owedToMe.sectionTitle }).filter({ visible: true });
  await expect(owed.getByText(/4\.532\.696/)).toBeVisible();
  await expect(owed.getByText(/Con intereses, .*4\.628\.410 en 1 cuota/)).toBeVisible();

  // Inicio and «Revisar el mes» call no cuota short: both were paid whole.
  await page.goto("/es");
  await expect(page.getByText(/cuotas? quedó|cuotas? quedaron/).first()).toHaveCount(0);
  await expect(page.getByText(/4\.532\.696/).first()).toBeVisible();
});

test("a purchase dated before a new debt began offers to begin it earlier, in place, and saves with one tap", async ({
  page,
}) => {
  // The debt is born as the form makes it: «¿Desde cuándo la tienes?» left at today.
  await page.goto("/es/planning/debts");
  await page.getByRole("button", { name: messages.debts.addCard, exact: true }).first().click();
  const created = page.getByRole("dialog");
  await created.getByRole("textbox", { name: messages.debts.nameLabel }).fill(CARD_NAME);
  await created.getByRole("textbox", { name: messages.debts.owedTodayLabel }).fill("100000");
  await expect(created.getByRole("textbox", { name: messages.debts.sinceLabel })).toHaveValue(typed(today));
  await created.getByRole("textbox", { name: messages.debts.creditLimitLabel }).fill("5000000");
  await created.getByRole("textbox", { name: messages.debts.minimumFixed, exact: true }).fill("30000");
  await created.getByRole("textbox", { name: messages.debts.annualRateLabel }).fill("24");
  await created.getByRole("button", { name: messages.debts.save, exact: true }).click();
  await expect(created).toBeHidden();

  const day = addCivilDays(today, -10);
  await page.goto("/es");
  await page.getByRole("button", { name: messages.transactions.quickPlaceholder, exact: true }).click();
  const form = page.getByRole("dialog");
  await form.locator("#movement-description").fill("Compra de octubre");
  await form.locator("#movement-amount").fill("25000");
  await form.locator("#movement-from").click();
  await page.getByRole("option", { name: CARD_NAME, exact: true }).click();
  await form.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await form.locator("#movement-date").fill(typed(day));
  await form.getByRole("button", { name: messages.transactions.saveMovement, exact: true }).click();

  // The refusal is not a dead end: it says when the debt begins and offers the day of the purchase.
  const offer = form.getByText(`Esta deuda empieza el`, { exact: false });
  await expect(offer).toBeVisible();
  await form.getByRole("button", { name: /^Cambiar a / }).click();

  // The purchase saved by that tap, the debt now begins on its day and the money is where it was.
  await expect(form).toBeHidden();
  const [card] = await fixtureSql<{ opened: string; id: string }[]>`
    select initial_balance_on::text as opened, id from accounts where owner_user_id = ${scope.userId} and name = ${CARD_NAME}`;
  expect(card.opened).toBe(day);
  const [saved] = await fixtureSql<{ amount: string; on: string }[]>`
    select amount_cents::text as amount, occurred_at::text as "on" from transactions where from_account_id = ${card.id}`;
  expect(saved).toEqual({ amount: "2500000", on: day });
});

test("«uber 38.000 ayer» on a savings account opened today offers to begin it yesterday and saves with one tap", async ({
  page,
}) => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.fresh}, ${scope.userId}, ${FRESH_NAME}, 'asset', 'bank', ${100_000_000}, ${today})`;
  });
  const yesterday = addCivilDays(today, -1);

  await page.goto("/es");
  await page.getByRole("button", { name: messages.transactions.quickPlaceholder, exact: true }).click();
  const form = page.getByRole("dialog");
  await form.locator("#movement-description").fill("uber 38.000 ayer");
  await form.locator("#movement-from").click();
  await page.getByRole("option", { name: FRESH_NAME, exact: true }).click();
  await form.getByRole("button", { name: scope.categoryName, exact: true }).click();
  await form.getByRole("button", { name: messages.transactions.saveMovement, exact: true }).click();

  await expect(form.getByText("Esta cuenta empieza el", { exact: false })).toBeVisible();
  await form.getByRole("button", { name: /^Cambiar a / }).click();
  await expect(form).toBeHidden();

  const [saved] = await fixtureSql<{ amount: string; on: string; opened: string }[]>`
    select t.amount_cents::text as amount, t.occurred_at::text as "on", a.initial_balance_on::text as opened
    from transactions t join accounts a on a.id = t.from_account_id where a.id = ${ids.fresh}`;
  expect(saved).toEqual({ amount: "3800000", on: yesterday, opened: yesterday });
});
