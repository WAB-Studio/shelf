/**
 * A credit somebody else pays (RF-211 to RF-213), from the credit's own screen: «Lo paga otra persona» links it to a
 * «Me debe» account, the section reads what is still owed and this month's two transfers, and «Registrar pago de
 * <persona>» books the payer's money as a transfer into the chosen account. Runs on both projects; on the phone
 * (360 px) the page never scrolls sideways.
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
  await expect(dialog.getByLabel(t.openingLabel)).toHaveValue(/300\.000|300,000/);
  await dialog.getByLabel(t.installmentLabel).fill("150000");
  await dialog.getByLabel(t.dueDayLabel).fill("15");
  await dialog.getByRole("button", { name: t.save }).click();
  await expect(dialog).toBeHidden();

  await expect(main.getByRole("heading", { name: t.title.replace("{person}", PERSON) })).toBeVisible();
  await expect(main.getByText(/Cuota .*150\.000 · vence el día 15/)).toBeVisible();
  await expect(main.getByText(t.notArrived)).toBeVisible();
  await expect(main.getByText(t.lenderNot)).toBeVisible();
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
});
