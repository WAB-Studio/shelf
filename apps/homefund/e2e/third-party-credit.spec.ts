/**
 * A credit somebody else pays (RF-211 to RF-213, RF-216, RF-217), from the credit's own screen: «Lo paga otra persona»
 * asks for the person alone and links the credit to a hidden «Me debe», the section reads what is still owed and this
 * month's two transfers, and «Registrar pago de <persona>» books the payer's money as a transfer into the chosen
 * account. The Accounts list shows the credit with its payer and no account of the payer's. Runs on both projects; on
 * the phone (360 px) the page never scrolls sideways.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";
import { addCivilDays, todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { pageOverflow } from "./fit";
import { asHarnessUser, readScope, test } from "./global-setup";

const t = messages.thirdPartyCredit;
const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const creditId = randomUUID();
const bankId = randomUUID();
const creditName = `Crédito tercero ${stamp}`;
const bankName = `Banco tercero ${stamp}`;
const PERSON = "Persona Uno";

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const opening = addCivilDays(todayInBogota(), -40);
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${creditId}, ${scope.userId}, ${creditName}, 'liability', 'loan', ${-300_000_00}, ${opening}),
        (${bankId}, ${scope.userId}, ${bankName}, 'asset', 'bank', ${500_000_00}, ${opening})`;
  });
});

test.afterAll(async () => {
  await asHarnessUser(async (tx) => {
    const [link] = await tx<{ receivable: string }[]>`
      select receivable_account_id as receivable from third_party_credits where liability_account_id = ${creditId}`;
    const accounts = [creditId, bankId, ...(link ? [link.receivable] : [])];
    await tx`delete from transactions where from_account_id in ${tx(accounts)} or to_account_id in ${tx(accounts)}`;
    await tx`delete from third_party_credits where liability_account_id = ${creditId}`;
    await tx`delete from accounts where id in ${tx(accounts)}`;
  });
});

test("a credit somebody else pays is set up, read and recorded from its screen", async ({ page }) => {
  await page.goto(`/es/planning/debts/${creditId}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: t.title.replace("{person}", PERSON) })).toBeHidden();

  // Set up: the person, a new «Me debe» at what the credit owes, the lender's installment and day.
  await main.getByRole("button", { name: t.setUp }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t.personLabel, { exact: true }).fill(PERSON);
  // The dialog asks for the person and the lender's terms; no account to choose, nothing to open.
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByLabel(t.installmentLabel).fill("150000");
  await dialog.getByLabel(t.dueDayLabel).fill("15");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(dialog).toBeHidden();

  await expect(main.getByRole("heading", { name: t.title.replace("{person}", PERSON) })).toBeVisible();
  await expect(main.getByText(/Cuota .*150\.000 · vence el día 15/)).toBeVisible();
  await expect(main.getByText(t.notArrived)).toBeVisible();
  await expect(main.getByText(t.lenderNot)).toBeVisible();

  // RF-267: the credit names who pays it near the top, offers its actions in plain buttons and warns before the
  // month's cuota is late; no invented «deuda cuando lo uniste» stands as the base (RF-301).
  await expect(main.getByText(t.introNoLender.replace("{person}", PERSON))).toBeVisible();
  await expect(main.getByText(/Deuda cuando lo uniste/)).toHaveCount(0);
  await expect(main.getByText(/Persona Uno aún no manda la cuota de .* \(vence el 15\)/)).toBeVisible();
  await expect(main.getByRole("button", { name: t.changePerson })).toBeVisible();
  await expect(main.getByRole("button", { name: t.unlink })).toBeVisible();

  // The button that set it up is gone; the credit has a payer now.
  await expect(main.getByRole("button", { name: t.setUp })).toBeHidden();

  // A payment from the person: the amount opens at the installment, and lands as a transfer, never an income.
  await main.getByRole("button", { name: t.register.replace("{person}", PERSON) }).click();
  await expect(dialog.getByLabel(t.amountLabel)).toHaveValue(/150\.000|150,000/);
  await dialog.getByLabel(t.toLabel).click();
  await page.getByRole("option", { name: bankName, exact: true }).click();
  await dialog.getByRole("button", { name: t.paymentSave }).click();
  await expect(dialog).toBeHidden();

  await expect(main.getByText(/Llegó .*150\.000 · /)).toBeVisible();
  await expect(main.getByText(t.lenderNot)).toBeVisible();

  const [moved] = await fixtureSql<{ kind: string; to: string; amount: string }[]>`
    select t.kind, t.to_account_id as "to", t.amount_cents::text as amount
    from transactions t join third_party_credits c on c.receivable_account_id = t.from_account_id
    where c.liability_account_id = ${creditId}`;
  expect(moved).toEqual({ kind: "transfer", to: bankId, amount: "15000000" });

  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

  // The Accounts list reads the credit with its payer and what they still owe, and holds no «Me debe» of its own.
  const receivableName = t.receivableName.replace("{person}", PERSON);
  await page.goto("/es/settings/accounts");
  // RF-318: the credit is named as its account; the payer is said once, in the line under it.
  await expect(page.getByText(creditName, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(`${creditName} (${PERSON})`)).toHaveCount(0);
  const paidBy = page.getByText(/Lo paga Persona Uno · le falta/).filter({ visible: true }).first();
  await expect(paidBy).toBeVisible();
  // The figure inside the line is the line's own size.
  const sizes = await paidBy.evaluate((line) => ({
    line: getComputedStyle(line).fontSize,
    figure: getComputedStyle(line.querySelector("button") as HTMLElement).fontSize,
  }));
  expect(sizes.figure).toBe(sizes.line);

  // RF-301: the figure opens how it is worked out: the capital the credit owes, which the payer's own sends do not lower.
  await page.getByRole("button", { name: t.breakdownOpen.replace("{person}", PERSON) }).filter({ visible: true }).first().click();
  const breakdown = page.getByRole("dialog");
  await expect(breakdown.getByRole("heading", { name: t.breakdownTitle.replace("{person}", PERSON) })).toBeVisible();
  await expect(breakdown.getByText(t.breakdownHow.replace("{person}", PERSON))).toBeVisible();
  await expect(breakdown.getByText(/Deuda cuando se unió/)).toHaveCount(0);
  await expect(breakdown.getByText(t.breakdownOwes, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(receivableName)).toHaveCount(0);

  // Nor does the full movement form offer it as a side of a movement.
  await page.goto("/es");
  await page.getByRole("button", { name: messages.transactions.quickPlaceholder, exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("combobox", { name: messages.transactions.accountLabel, exact: true }).click();
  await expect(page.getByRole("option", { name: bankName, exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: receivableName, exact: true })).toHaveCount(0);
});

// A loan somebody else pays, read as one thing (RF-287, RF-288, RF-289): one figure on top, rows that say how short they
// were paid, no blocks of a card, and the payer's earlier payments accepted although the credit was followed today.
test.describe("a loan with a plan of payments and a payer", () => {
  const loanId = randomUUID();
  const bankId2 = randomUUID();
  const receivableId = randomUUID();
  const loanName = `Préstamo plan ${stamp}`;
  const bankName2 = `Banco plan ${stamp}`;
  const PAYER = "Persona Dos";
  // Cents: a cuota of 80.000 pesos made of 70.000 of capital, 8.000 of interest and 2.000 of insurance.
  const TOTAL = 8_000_000;
  const PRINCIPAL = 7_000_000;
  const FIRST_PAID = 7_200_000;

  test.beforeAll(async () => {
    const today = todayInBogota();
    await asHarnessUser(async (tx) => {
      const opening = addCivilDays(today, -60);
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values
          (${loanId}, ${scope.userId}, ${loanName}, 'liability', 'loan', ${-4 * PRINCIPAL}, ${opening}),
          (${bankId2}, ${scope.userId}, ${bankName2}, 'asset', 'bank', ${50_000_000}, ${opening}),
          (${receivableId}, ${scope.userId}, ${`Me debe ${stamp}`}, 'asset', 'receivable', ${13_000_000}, ${today})`;
      // Four cuotas: the first two fell 45 and 15 days ago, and the second was paid 10 % short.
      for (const [index, offset] of [-45, -15, 15, 45].entries()) {
        await tx`
          insert into loan_schedule_rows (account_id, number, due_on, principal_cents, interest_cents, insurance_cents,
            total_cents, remaining_cents)
          values (${loanId}, ${index + 1}, ${addCivilDays(today, offset)}, ${PRINCIPAL}, ${800_000}, ${200_000},
            ${TOTAL}, ${(3 - index) * PRINCIPAL})`;
      }
      await tx`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, description)
        values
          (${bankId2}, ${loanId}, ${TOTAL}, ${addCivilDays(today, -45)}, ${`Cuota 1 ${stamp}`}),
          (${bankId2}, ${loanId}, ${FIRST_PAID}, ${addCivilDays(today, -15)}, ${`Cuota 2 ${stamp}`})`;
      await tx`
        insert into third_party_credits (liability_account_id, receivable_account_id, person_name, installment_cents)
        values (${loanId}, ${receivableId}, ${PAYER}, ${TOTAL})`;
    });
  });

  test.afterAll(async () => {
    await asHarnessUser(async (tx) => {
      const accountIds = [loanId, bankId2, receivableId];
      await tx`delete from transactions where from_account_id in ${tx(accountIds)} or to_account_id in ${tx(accountIds)}`;
      await tx`delete from third_party_credits where liability_account_id = ${loanId}`;
      await tx`delete from accounts where id in ${tx(accountIds)}`;
    });
  });

  test("shows one figure on top, rows paid short as partial and counters that add up", async ({ page }) => {
    await page.goto(`/es/planning/debts/${loanId}`);
    const main = page.getByRole("main");

    // One cuota paid whole, one paid 8.000 short, two to come: 8.000 + 80.000 + 80.000 still to pay, in three cuotas.
    await expect(main.getByText(/^Falta pagar /)).toHaveCount(1);
    await expect(main.getByText(/^Falta pagar .*168\.000 en 3 cuotas$/)).toBeVisible();

    // The row paid short says how much is missing, and no row reads «Vencida» for it.
    await expect(main.getByText(/Parcial · faltan .*8\.000/)).toBeVisible();
    await expect(main.getByText(messages.loanSchedule.stateOverdue, { exact: true })).toHaveCount(0);
    await expect(main.getByText(messages.loanSchedule.statePaid, { exact: true })).toHaveCount(1);

    // «De dónde sale» holds the other figures, each adding to the one above.
    await main.getByRole("button", { name: messages.loanStanding.open }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(messages.loanStanding.linePaid, { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 de 4", { exact: true })).toBeVisible();
    await expect(dialog.getByText(messages.loanStanding.linePartial, { exact: true })).toBeVisible();
    // The payer's figure is the loan's capital, so no second line says it or why it would differ.
    await expect(dialog.getByText(new RegExp(`^${PAYER} te debe`))).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The payer's section keeps its own side only: nothing in it says what the loan lacks a second time.
    await expect(main.getByText(/Le falta .* \(capital\)/)).toHaveCount(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a loan carries none of a card's blocks, and a card offers no payer", async ({ page }) => {
    await page.goto(`/es/planning/debts/${loanId}`);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: messages.debts.settlement.title })).toHaveCount(0);
    await expect(main.getByText(messages.installments.currentPeriod, { exact: true })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: messages.installments.statementsTitle })).toHaveCount(0);

    const cardId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${cardId}, ${scope.userId}, ${`Tarjeta sin tercero ${stamp}`}, 'liability', 'card', ${-10_000_000}, ${todayInBogota()})`;
    });
    try {
      await page.goto(`/es/planning/debts/${cardId}`);
      await expect(page.getByRole("main").getByRole("heading", { name: messages.debts.settlement.title })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button", { name: messages.thirdPartyCredit.setUp })).toHaveCount(0);
    } finally {
      await asHarnessUser(async (tx) => {
        await tx`delete from accounts where id = ${cardId}`;
      });
    }
  });

  test("a payment of the payer dated before the credit was followed is accepted and moves nothing they owe", async ({
    page,
  }) => {
    const read = () => fixtureSql<{ balance: string; opened: string; opening: string }[]>`
      select b.balance_cents::text as balance, a.initial_balance_on::text as opened, a.initial_balance_cents::text as opening
      from accounts a join account_balances b on b.id = a.id where a.id = ${receivableId}`;
    const [before] = await read();

    const when = addCivilDays(todayInBogota(), -58);
    const [year, month, day] = when.split("-");
    await page.goto(`/es/planning/debts/${loanId}`);
    const main = page.getByRole("main");
    await main.getByRole("button", { name: t.register.replace("{person}", PAYER) }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(t.toLabel).click();
    await page.getByRole("option", { name: bankName2, exact: true }).click();
    await dialog.getByLabel(t.amountLabel).fill("50000");
    await dialog.getByLabel(t.dateLabel).fill(`${day}/${month}/${year}`);
    await dialog.getByRole("button", { name: t.paymentSave }).click();

    // No refusal about the opening of an account the person cannot see.
    await expect(dialog).toBeHidden();
    await expect(page.getByText(messages.errors.movementBeforeOpening)).toHaveCount(0);

    const [after] = await read();
    expect(after.opened).toBe(when);
    // The payer owed that much more then: what they owe today is the figure it was.
    expect(Number(after.opening)).toBe(Number(before.opening) + 5_000_000);
    expect(after.balance).toBe(before.balance);

    // «Mes a mes» reads that month, and a month the lender was paid and the payer sent nothing says so.
    await expect(main.getByText(t.notSent.replace("{person}", PAYER)).filter({ visible: true }).first()).toBeVisible();
  });
});
