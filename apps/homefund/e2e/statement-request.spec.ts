/**
 * RF-259, RF-260 from the screens: a savings account that says its statement comes every three months is asked for it
 * once the quarter has closed, in Cuentas and in one line on Inicio, until a count covers the period; Inicio's recent
 * movements leave a reconciliation's adjustment out.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import { latestClosedPeriod } from "@/lib/statement-cadence";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const common = messages.common;
const dashboard = messages.dashboard;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const TODAY = todayInBogota();
const PERIOD = latestClosedPeriod("quarterly", TODAY);

type Seeded = { id: string; name: string };

// A savings account opened and added long before the quarter closed, with the cadence the test names.
async function seed(label: string, cadence: string | null): Promise<Seeded> {
  const id = randomUUID();
  const name = `Extracto ${stamp} ${label}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, settlement_currency, statement_cadence)
      values (${id}, ${scope.userId}, ${name}, 'asset', 'bank', 50000000, ${addCivilDays(TODAY, -400)}, 'COP', ${cadence})`;
  });
  await fixtureSql`update accounts set created_at = now() - interval '400 days' where id = ${id}`;

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

const REQUEST_MARK = /^Llegó el extracto \(.+\)\. Pásaselo a Claude\.$/;

const INICIO_LINE = /^Llegó el extracto de .+\. Pásaselo a Claude\.$/;

async function cadenceOf(account: Seeded) {
  const [row] = await fixtureSql<{ cadence: string | null; through: string | null }[]>`
    select statement_cadence as cadence, statement_dismissed_through::text as through from accounts where id = ${account.id}`;
  return row;
}

test.describe("the statement HomeFund waits for", () => {
  test("marks the quarterly account in Cuentas, not the unset one, and stops when a count covers the period", async ({
    page,
  }) => {
    const quarterly = await seed("trimestral", "quarterly");
    const unset = await seed("sin definir", null);
    try {
      await page.goto("/es/settings/accounts");
      await expect(listed(page, quarterly.name).getByText(REQUEST_MARK)).toBeVisible();
      await expect(listed(page, unset.name).getByText(REQUEST_MARK)).toHaveCount(0);

      // A count on the period's last day covers it.
      await asHarnessUser(async (tx) => {
        await tx`
          insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
          values (${quarterly.id}, ${PERIOD.end}, 50100000)`;
      });
      await page.goto("/es/settings/accounts");
      await expect(listed(page, quarterly.name)).toBeVisible();
      await expect(listed(page, quarterly.name).getByText(REQUEST_MARK)).toHaveCount(0);
    } finally {
      await drop(quarterly);
      await drop(unset);
    }
  });

  test("Inicio asks in one line, and «Ahora no» leaves the period alone without touching the cadence", async ({ page }) => {
    const quarterly = await seed("trimestral", "quarterly");
    try {
      await page.goto("/es");
      const line = page.getByText(INICIO_LINE).filter({ visible: true });
      await expect(line).toHaveCount(1);

      await page.getByRole("button", { name: dashboard.statementRequestLater, exact: true }).filter({ visible: true }).click();
      await expect(page.getByText(INICIO_LINE).filter({ visible: true })).toHaveCount(0);
      expect(await cadenceOf(quarterly)).toEqual({ cadence: "quarterly", through: PERIOD.end });

      await page.goto("/es/settings/accounts");
      await expect(listed(page, quarterly.name)).toBeVisible();
      await expect(listed(page, quarterly.name).getByText(REQUEST_MARK)).toHaveCount(0);
    } finally {
      await drop(quarterly);
    }
  });

  test("«No me lo pidas» turns the account's cadence off", async ({ page }) => {
    const quarterly = await seed("trimestral", "quarterly");
    try {
      await page.goto("/es");
      await page.getByRole("button", { name: dashboard.statementRequestStop, exact: true }).filter({ visible: true }).click();
      await expect(page.getByText(INICIO_LINE).filter({ visible: true })).toHaveCount(0);
      expect(await cadenceOf(quarterly)).toEqual({ cadence: null, through: null });
    } finally {
      await drop(quarterly);
    }
  });

  test("Inicio's recent movements leave the count's adjustment out, and Movimientos keeps it", async ({ page }) => {
    const account = await seed("diferencia", null);
    try {
      await asHarnessUser(async (tx) => {
        await tx`
          insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
          values (${account.id}, ${addCivilDays(TODAY, -1)}, 51200000)`;
      });

      await page.goto("/es");
      await expect(page.getByText(account.name)).toHaveCount(0);

      await page.goto("/es/movements");
      await expect(page.getByText(account.name).filter({ visible: true }).first()).toBeVisible();
    } finally {
      await drop(account);
    }
  });
});
