/**
 * RF-262 from the screens: an account not counted for over a month carries a quiet «Cuádrala» in Cuentas that opens
 * its own «Cuadrar», and Inicio says so in one line that opens «Cuadrar todo». An account counted lately carries
 * neither mark.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const TODAY = todayInBogota();
const OPENED = addCivilDays(TODAY, -90);

type Seeded = { id: string; name: string };

// An account opened 90 days ago and counted on `countedOn`, when it was counted at all.
async function seed(label: string, countedOn: string | null): Promise<Seeded> {
  const id = randomUUID();
  const name = `Aviso ${stamp} ${label}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, settlement_currency)
      values (${id}, ${scope.userId}, ${name}, 'asset', 'bank', 50000000, ${OPENED}, 'COP')`;
    if (countedOn) {
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${id}, ${countedOn}, 50000000)`;
    }
  });

  return { id, name };
}

async function drop(account: Seeded): Promise<void> {
  await fixtureSql`
    delete from transactions where from_account_id = ${account.id} or to_account_id = ${account.id}`;
  await fixtureSql`delete from account_reconciliations where account_id = ${account.id}`;
  await fixtureSql`delete from accounts where id = ${account.id}`;
}

function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", { name: common.actionsFor.replace("{name}", name), exact: true });
}

// Both bands stay in the DOM and CSS displays one; the row or card is whatever is displayed and names the account.
function listed(page: Page, name: string): Locator {
  const row = page.getByRole("row").filter({ hasText: name }).filter({ visible: true });
  const card = page
    .locator("main > div > .rt-Box")
    .filter({ visible: true })
    .locator("div")
    .filter({ has: rowMenu(page, name) })
    .filter({ hasText: name })
    .last();

  return row.or(card).first();
}

test.describe("«Cuádrala»", () => {
  test("marks the account not counted for 40 days, leaves the one counted 5 days ago, and opens its Cuadrar", async ({
    page,
  }) => {
    const old = await seed("vieja", addCivilDays(TODAY, -40));
    const fresh = await seed("reciente", addCivilDays(TODAY, -5));
    try {
      await page.goto("/es/settings/accounts");
      await expect(listed(page, old.name).getByRole("button", { name: accounts.reconcileNudge, exact: true })).toBeVisible();
      await expect(listed(page, fresh.name)).toBeVisible();
      await expect(listed(page, fresh.name).getByRole("button", { name: accounts.reconcileNudge, exact: true })).toHaveCount(0);

      await listed(page, old.name).getByRole("button", { name: accounts.reconcileNudge, exact: true }).click();
      await expect(
        page.getByRole("dialog").getByText(accounts.reconcileTitle.replace("{name}", old.name), { exact: true }),
      ).toBeVisible();
    } finally {
      await drop(old);
      await drop(fresh);
    }
  });

  test("Inicio carries one line for the accounts not counted in a month, and it opens «Cuadrar todo»", async ({ page }) => {
    const old = await seed("vieja", addCivilDays(TODAY, -40));
    try {
      await page.goto("/es");
      const line = page.getByRole("link", { name: /sin cuadrar hace más de un mes · Cuadrar todo$/ }).filter({ visible: true });
      await expect(line).toHaveCount(1);

      await line.click();
      await expect(page).toHaveURL(/\/settings\/accounts\/reconcile$/);
      await expect(page.getByRole("heading", { name: accounts.reconcileAllTitle, exact: true })).toBeVisible();
    } finally {
      await drop(old);
    }
  });
});
