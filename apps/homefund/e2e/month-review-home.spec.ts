/**
 * Inicio's «Revisar <mes>» line (RF-155): while last month holds an item nobody
 * marked, one line counts them and opens that month's review; once every one is
 * marked there is no line. The twins are seeded on an account of this spec's own,
 * opened before last month, and dropped by id.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";
import { lastClosedMonth, shiftMonth } from "@/lib/dates";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const month = lastClosedMonth();
const monthName = MONTHS[Number(month.slice(5, 7)) - 1];
const accountId = randomUUID();
// A category of the spec's own with no history: no split here is ever «above usual».
const categoryId = randomUUID();
let movements: string[] = [];

// Two equal expenses on one day of last month: one «Dos iguales» item, two movements.
async function seedTwins(cents: number, day: string): Promise<string[]> {
  const ids: string[] = [];
  await asHarnessUser(async (tx) => {
    for (let i = 0; i < 2; i++) {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${accountId}, ${cents}, ${`${month}-${day}`}, ${`Inicio revisión ${stamp}`}) returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${movement.id}, ${categoryId}, ${cents})`;
      ids.push(movement.id);
    }
  });
  movements.push(...ids);
  return ids;
}

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${scope.userId}, ${`Cuenta inicio ${stamp}`}, 'asset', 'bank', 0, ${`${shiftMonth(month, -1)}-01`})`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${`Inicio ${stamp}`}, 'expense', '#8C4A4A')`;
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from transactions where id in ${fixtureSql(movements)}`;
  await fixtureSql`delete from accounts where id = ${accountId}`;
  await fixtureSql`delete from categories where id = ${categoryId}`;
  movements = [];
});

const line = (page: Page) => page.getByRole("link", { name: new RegExp(`^Revisar ${monthName} · `) });

for (const width of [360, 1280]) {
  test(`at ${width} one unmarked twin reads «2 movimientos» and the line opens last month's review`, async ({ page }) => {
    await seedTwins(5_000_000, "15");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/es");
    await expect(line(page)).toHaveText(`Revisar ${monthName} · 2 movimientos`);
    await line(page).click();
    await expect(page).toHaveURL(new RegExp(`/es/reports/review\\?month=${month}$`));
  });
}

test("two twins count «4 movimientos»; every one marked leaves no line", async ({ page }) => {
  const first = await seedTwins(5_000_000, "15");
  const second = await seedTwins(7_000_000, "16");
  await page.goto("/es");
  await expect(line(page)).toHaveText(`Revisar ${monthName} · 4 movimientos`);

  await asHarnessUser(async (tx) => {
    for (const id of [...first, ...second]) {
      await tx`insert into transaction_reviews (transaction_id, rule) values (${id}, 'twin')`;
    }
  });
  // The reload waits for the server's whole page, so an absent line is absent, not late.
  await page.reload();
  await expect(line(page)).toHaveCount(0);
});
