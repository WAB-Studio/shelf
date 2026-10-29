/**
 * Inicio's «Revisar <mes>» line (RF-155): while last month holds an item nobody
 * marked, one line counts them and opens that month's review; once every one is
 * marked there is no line. The twins are seeded on an account of this spec's own,
 * opened before last month, and dropped by id.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { HARNESS_EMAIL } from "../scripts/harness/session";
import { asHarnessUser, clearGroup, readScope, test } from "./global-setup";
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

test("an invitation waiting for this address is answered first: Inicio shows its card alone, no «Revisar» line", async ({ page }) => {
  await clearGroup();
  await seedTwins(5_000_000, "15");
  await page.goto("/es");
  await expect(line(page)).toHaveText(`Revisar ${monthName} · 2 movimientos`);
  // A fund the second identity leads, with a pending row addressed to the first one's email.
  const groupId = randomUUID();
  const inviter = `Carlos ${stamp}`;
  const fund = `Casa ${stamp}`;
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: scope.memberUserId, role: "authenticated", aud: "authenticated" })}, true)`;
    await tx`insert into groups (id, name, cash_mode) values (${groupId}, ${fund}, 'per_member')`;
    await tx`insert into group_members (group_id, user_id, name, role) values (${groupId}, ${scope.memberUserId}, ${inviter}, 'leader')`;
    await tx`
      insert into group_members (group_id, name, role, invite_email)
      values (${groupId}, ${`Invitado ${stamp}`}, 'member', ${HARNESS_EMAIL})`;
  });
  try {
    await page.goto("/es");
    await expect(page.getByRole("heading", { name: `${inviter} te invitó a su fondo «${fund}»`, exact: true })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
  } finally {
    await fixtureSql`delete from group_members where group_id = ${groupId}`;
    await fixtureSql`delete from groups where id = ${groupId}`;
  }
});
