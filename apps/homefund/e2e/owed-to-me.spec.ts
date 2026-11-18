/**
 * RF-293 to RF-295 from the screens: after spending for Carlos and noting what he returned, his page in Etiquetas
 * reads «Gastaste $X para Carlos · te devolvió $Y · falta $Z», Inicio says «Te deben» with his name and Cuentas lists
 * him; each figure opens the lines it is built from.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const owed = messages.owedToMe;
const labels = messages.labels;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const TODAY = todayInBogota();

test("spending for a charged person and noting his return shows what is still owed, on his page, Inicio and Cuentas", async ({ page }) => {
  const ids = { account: randomUUID(), expenseCategory: randomUUID(), incomeCategory: randomUUID(), carlos: randomUUID() };
  const carlos = `Carlos ${stamp}`;
  const movements: string[] = [];

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, settlement_currency)
      values (${ids.account}, ${scope.userId}, ${`Banco te deben ${stamp}`}, 'asset', 'bank', 100000000, ${addCivilDays(TODAY, -30)}, 'COP')`;
    await tx`insert into categories (id, owner_user_id, name, kind, color) values
      (${ids.expenseCategory}, ${scope.userId}, ${`Gasto ${stamp}`}, 'expense', '#8C4A4A'),
      (${ids.incomeCategory}, ${scope.userId}, ${`Ingreso ${stamp}`}, 'income', '#2F7D5B')`;
    await tx`insert into labels (id, owner_user_id, name, kind, charge_default) values (${ids.carlos}, ${scope.userId}, ${carlos}, 'person', true)`;
    const book = async (from: string | null, to: string | null, cents: number, category: string, what: string) => {
      const [row] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, to_account_id, amount_cents, occurred_at, description)
        values (${from}, ${to}, ${cents}, ${TODAY}, ${`${what} ${stamp}`})
        returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${row.id}, ${category}, ${cents})`;
      await tx`insert into transaction_labels (transaction_id, label_id) values (${row.id}, ${ids.carlos})`;
      movements.push(row.id);
    };
    await book(ids.account, null, 10000000, ids.expenseCategory, "Almuerzo");
    await book(ids.account, null, 5000000, ids.expenseCategory, "Mercado");
    await book(null, ids.account, 4000000, ids.incomeCategory, "Devolvió");
  });

  try {
    await page.goto("/es/settings/labels");
    await page
      .getByRole("link", { name: labels.personOpen.replace("{name}", carlos), exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const summary = page.getByText(`para ${carlos} · te devolvió`).first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("150.000");
    await expect(summary).toContainText("40.000");
    await expect(summary).toContainText("falta");
    await expect(summary).toContainText("110.000");
    await expect(page.getByText(`Almuerzo ${stamp}`)).toBeVisible();
    await expect(page.getByText(`Devolvió ${stamp}`)).toBeVisible();

    await page.goto("/es");
    const button = page.getByRole("button", { name: owed.openFor.replace("{person}", carlos), exact: true });
    await expect(button).toBeVisible();
    await expect(button).toContainText("110.000");
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(owed.breakdownTitle.replace("{person}", carlos), { exact: true })).toBeVisible();
    await expect(dialog.getByText(owed.breakdownOwes, { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Te devolvió el/)).toBeVisible();

    // «Registrar pago» opens the movement form on «Ingreso» with «Te lo devolvió» already naming the person.
    await dialog.getByRole("button", { name: owed.breakdownRegisterPayment, exact: true }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("radio", { name: messages.transactions.kindIncome, exact: true })).toBeChecked();
    await expect(form.locator("#movement-for-person")).toContainText(carlos);
    await page.keyboard.press("Escape");

    await page.goto("/es/settings/accounts");
    await expect(page.getByRole("region", { name: owed.sectionTitle }).filter({ visible: true })).toContainText(carlos);
  } finally {
    await fixtureSql`delete from transactions where id = any(${movements})`;
    await fixtureSql`delete from labels where id = ${ids.carlos}`;
    await fixtureSql`delete from categories where id in ${fixtureSql([ids.expenseCategory, ids.incomeCategory])}`;
    await fixtureSql`delete from accounts where id = ${ids.account}`;
  }
});

test("writing «Ya te debía» on a person who is not charged makes Te deben name them, with the old debt as its own line and on their page", async ({ page }) => {
  const person = `Yulieth ${stamp}`;
  const personId = randomUUID();
  await asHarnessUser(async (tx) => {
    await tx`insert into labels (id, owner_user_id, name, kind, charge_default) values (${personId}, ${scope.userId}, ${person}, 'person', false)`;
  });

  try {
    await page.goto("/es/settings/labels");
    await page
      .getByRole("button", { name: common.actionsFor.replace("{name}", person), exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(labels.alreadyOwedAmountLabel, { exact: true }).fill("385766");
    await expect(dialog.getByText(labels.chargeForced)).toBeVisible();
    await dialog.getByRole("button", { name: common.save, exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.goto("/es/settings/accounts");
    const section = page.getByRole("region", { name: owed.sectionTitle });
    await expect(section).toContainText(person);
    await expect(section).toContainText(owed.sourceOpening);
    await expect(section).toContainText("385.766");

    await section.getByRole("button", { name: owed.openFor.replace("{person}", person), exact: true }).click();
    await expect(page.getByRole("dialog").getByText(/Ya te debía desde el/)).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`/es/settings/labels/${personId}`);
    const summary = page.getByText(/^Ya te debía/).first();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("385.766");
    await expect(summary).toContainText("falta");
  } finally {
    await fixtureSql`delete from labels where id = ${personId}`;
  }
});
