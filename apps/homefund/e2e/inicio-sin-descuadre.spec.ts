/**
 * RF-263 from the screens: Inicio's recent movements leave a reconciliation's adjustment («Descuadre») out, and
 * Movimientos keeps it.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const TODAY = todayInBogota();

test("Inicio's recent movements leave the count's adjustment out, and Movimientos keeps it", async ({ page }) => {
  const id = randomUUID();
  const name = `Descuadre inicio ${stamp}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on, settlement_currency)
      values (${id}, ${scope.userId}, ${name}, 'asset', 'bank', 50000000, ${addCivilDays(TODAY, -30)}, 'COP')`;
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${id}, ${addCivilDays(TODAY, -1)}, 51200000)`;
  });

  try {
    await page.goto("/es");
    await expect(page.getByText(name)).toHaveCount(0);

    await page.goto("/es/movements");
    await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
  } finally {
    await fixtureSql`delete from transactions where from_account_id = ${id} or to_account_id = ${id}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${id}`;
    await fixtureSql`delete from accounts where id = ${id}`;
  }
});
