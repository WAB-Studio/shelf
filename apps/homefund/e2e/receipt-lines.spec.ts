/**
 * RF-175: a receipt is one movement whose splits are its lines. The detail lists each line with
 * its product name, its category path («Mercado › Lácteos») and its amount, two of them in the
 * same category, and the ledger keeps the one row with the number of lines.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const scope = readScope();
const tag = randomUUID().slice(0, 8);
const marketId = randomUUID();
const dairyId = randomUUID();
const homeId = randomUUID();
const marketName = `Mercado ${tag}`;
const DESCRIPTION = `Harness factura ${tag}`;

let movementId = "";

// The desktop table and the phone's cards share the DOM; one width keeps the detail to one shape.
test.use({ viewport: { width: 1280, height: 900 } });

test.beforeEach(async () => {
  await clearLedger();
  await asHarnessUser(async (tx) => {
    await tx`insert into categories (id, owner_user_id, name, kind, color)
      values (${marketId}, ${scope.userId}, ${marketName}, 'expense', '#4C8C4A'), (${homeId}, ${scope.userId}, ${`Hogar ${tag}`}, 'expense', '#B54708')`;
    await tx`insert into categories (id, owner_user_id, name, kind, color, parent_id)
      values (${dairyId}, ${scope.userId}, 'Lácteos', 'expense', '#4C8C4A', ${marketId})`;
    const [movement] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${scope.accountId}, 1200000, (now() at time zone ${TIME_ZONE})::date, ${DESCRIPTION})
      returning id`;
    movementId = movement.id;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents, description) values
      (${movementId}, ${dairyId}, 400000, 'Leche entera'),
      (${movementId}, ${dairyId}, 300000, 'Yogurt natural'),
      (${movementId}, ${homeId}, 500000, 'Bombillo LED')`;
  });
});

test.afterEach(async () => {
  await clearLedger();
  await fixtureSql`delete from categories where id = ${dairyId}`;
  await fixtureSql`delete from categories where id in (${marketId}, ${homeId})`;
});

test("the detail lists a receipt's lines with their names and category paths, the ledger keeps one row", async ({
  page,
}) => {
  await page.goto("/es/movements");
  await expect(page.getByRole("row").filter({ hasText: DESCRIPTION })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: DESCRIPTION })).toContainText("3 líneas");

  await page.goto(`/es/movements/${movementId}`);
  for (const product of ["Leche entera", "Yogurt natural", "Bombillo LED"]) {
    await expect(page.getByText(product).filter({ visible: true })).toHaveCount(1);
  }
  await expect(page.getByText(`${marketName} › Lácteos`).filter({ visible: true })).toHaveCount(2);
});
