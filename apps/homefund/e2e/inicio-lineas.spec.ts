/**
 * Inicio answers in short lines (RF-268, RF-269): what is in the accounts as the big figure with the net worth under
 * it, this month's payments with each card's statement total, the month's spending, «Por arreglar» and «Viene»; at 390
 * and at 1280. Every row is this spec's own and dropped by id.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { addCivilDays, currentMonthRange, todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const TODAY = todayInBogota();
const MONTH_END = addCivilDays(currentMonthRange().endExclusive, -1);

const ids = {
  savings: randomUUID(),
  pocket: randomUUID(),
  visa: randomUUID(),
  master: randomUUID(),
  counted: randomUUID(),
};
const names = {
  savings: `Ahorros ${stamp}`,
  pocket: `Bolsillo ${stamp}`,
  visa: `Visa ${stamp}`,
  master: `Master ${stamp}`,
  counted: `Cuadrada ${stamp}`,
};
const paymentIds = [randomUUID(), randomUUID(), randomUUID()];

// What the harness user holds in asset accounts, read from the view the screens read.
async function haveCents(): Promise<number> {
  const [row] = await fixtureSql<{ cents: string | null }[]>`
    select sum(b.balance_cents)::text as cents
    from account_balances b join accounts a on a.id = b.id
    where a.owner_user_id = ${scope.userId} and a.kind = 'asset' and a.subtype <> 'receivable'
      and a.archived_at is null and b.currency = 'COP'`;
  return Number(row?.cents ?? 0);
}

function pesos(cents: number): string {
  return `$ ${String(Math.abs(Math.trunc(cents / 100))).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function flat(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const opened = addCivilDays(TODAY, -60);
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${ids.savings}, ${scope.userId}, ${names.savings}, 'asset', 'bank', 90_000_000, ${opened}),
        (${ids.pocket}, ${scope.userId}, ${names.pocket}, 'asset', 'bank', 0, ${opened}),
        (${ids.visa}, ${scope.userId}, ${names.visa}, 'liability', 'card', -150_000_000, ${opened}),
        (${ids.master}, ${scope.userId}, ${names.master}, 'liability', 'card', -50_000_000, ${opened}),
        (${ids.counted}, ${scope.userId}, ${names.counted}, 'asset', 'bank', 50_000_000, ${addCivilDays(TODAY, -30)})`;
    await tx`update accounts set parent_account_id = ${ids.savings} where id = ${ids.pocket}`;
    await tx`
      insert into debt_terms (account_id, debt_kind, annual_rate, minimum_payment_cents, credit_limit_cents, statement_cut_off_day, payment_due_day)
      values
        (${ids.visa}, 'revolving', 0.28, 30_000_000, 500_000_000, 15, 5),
        (${ids.master}, 'revolving', 0.28, null, 500_000_000, null, ${Number(TODAY.slice(8))})`;
    await tx`
      insert into account_statements (account_id, period_start, cut_off_date, payment_due_date, closing_balance_cents, minimum_payment_cents)
      values (${ids.visa}, ${addCivilDays(TODAY, -45)}, ${addCivilDays(TODAY, -1)}, ${MONTH_END}, -120_000_000, 30_000_000)`;
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${ids.counted}, ${TODAY}, 51_200_000)`;
    // The savings were last counted 40 days ago, to the cent: past the month «Cuadrar todo» waits for.
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${ids.savings}, ${addCivilDays(TODAY, -40)}, 90_000_000)`;
    // The pocket spends 150.000 it never held, and the account spends 25.000: one expense of each this month.
    const [overdrawn] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${ids.pocket}, 15_000_000, ${TODAY}, ${`Bolsillo gasto ${stamp}`}) returning id`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${overdrawn.id}, ${scope.categoryId}, 15_000_000)`;
    const [spent] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (${ids.savings}, 2_500_000, ${TODAY}, ${`Gasto línea ${stamp}`}) returning id`;
    await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${spent.id}, ${scope.categoryId}, 2_500_000)`;
    await tx`
      insert into planned_payments (id, owner_user_id, from_account_id, amount_cents, due_date, description, status, created_by)
      values (${paymentIds[0]}, ${scope.userId}, ${ids.savings}, 22_000_000, ${TODAY}, ${`EPM ${stamp}`}, 'pending', ${scope.userId})`;
    await tx`
      insert into planned_payments (id, owner_user_id, to_account_id, amount_cents, due_date, description, status, created_by)
      values (${paymentIds[1]}, ${scope.userId}, ${ids.savings}, 80_000_000, ${addCivilDays(TODAY, 3)}, ${`Cliente ${stamp}`}, 'pending', ${scope.userId})`;
  });
});

test.afterAll(async () => {
  await fixtureSql`delete from planned_payments where id in ${fixtureSql(paymentIds)}`;
  const all = Object.values(ids);
  await fixtureSql`delete from transactions where from_account_id in ${fixtureSql(all)} or to_account_id in ${fixtureSql(all)}`;
  await fixtureSql`delete from account_reconciliations where account_id in ${fixtureSql(all)}`;
  await fixtureSql`delete from account_statements where account_id in ${fixtureSql(all)}`;
  await fixtureSql`delete from accounts where id = ${ids.pocket}`;
  await fixtureSql`delete from accounts where id in ${fixtureSql(all)}`;
});

function line(page: Page, name: "pays" | "spent" | "fix" | "ahead") {
  return page.locator(`[data-line="${name}"]`).filter({ visible: true });
}

for (const width of [390, 1280]) {
  test.describe(`at ${width}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/es");
    });

    test("the big figure is what the accounts hold and the net worth opens its sum", async ({ page }) => {
      const net = page.locator('[data-card="net"]');
      await expect(net).toContainText("Tienes en tus cuentas");
      expect(flat(await net.innerText())).toContain(pesos(await haveCents()));

      await net.getByRole("button", { name: /^Patrimonio .* ver la resta$/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Cómo sale tu patrimonio")).toBeVisible();
      await expect(dialog.getByText("Lo que debes en tarjetas y créditos")).toBeVisible();
      await dialog.getByRole("button", { name: "Cerrar" }).click();
      await expect(dialog).toBeHidden();
    });

    test("«Este mes pagas» totals the statement and the payment, shows the minimum and asks for the missing extract", async ({ page }) => {
      const pays = line(page, "pays");
      await expect(pays.getByRole("heading", { name: /^Este mes pagas/ })).toBeVisible();
      expect(flat(await pays.innerText())).toContain("Este mes pagas $ 1.420.000");
      await expect(pays.getByRole("link", { name: new RegExp(`^${names.visa} \\$\\s1\\.200\\.000 el \\d+ .+ \\(mínimo \\$\\s300\\.000\\s?\\)$`) })).toBeVisible();
      await expect(pays.getByRole("link", { name: new RegExp(`^${names.master} el \\d+ .+: falta su extracto$`) })).toBeVisible();
      await expect(pays.getByRole("link", { name: new RegExp(`^EPM ${stamp} \\$\\s220\\.000 el `) })).toBeVisible();
    });

    test("«En <mes> gastaste» names the figure and the top categories", async ({ page }) => {
      const spent = line(page, "spent");
      await expect(spent.getByRole("heading", { name: /^En [a-zñ]+ gastaste / })).toBeVisible();
      await expect(spent).toContainText(scope.categoryName);
    });

    test("«Por arreglar» lists the pocket below zero and the accounts to count, each with its link", async ({ page }) => {
      const fix = line(page, "fix");
      await expect(fix.getByRole("heading", { name: "Por arreglar" })).toBeVisible();
      const pocket = fix.getByRole("link", { name: new RegExp(`^${names.pocket} gastó \\$\\s150\\.000 más de lo que tenía$`) });
      await expect(pocket).toHaveAttribute("href", "/es/settings/accounts");
      await expect(fix.getByRole("link", { name: /sin cuadrar hace más de un mes · Cuadrar todo$/ })).toHaveAttribute(
        "href",
        "/es/settings/accounts/reconcile",
      );
    });

    test("«Viene» names the next income expected and the next bill", async ({ page }) => {
      const ahead = line(page, "ahead");
      await expect(ahead.getByRole("heading", { name: "Viene" })).toBeVisible();
      await expect(ahead.getByRole("link", { name: new RegExp(`^Ingreso de \\$\\s800\\.000 \\(Cliente ${stamp}\\) el `) })).toBeVisible();
      await expect(ahead.getByRole("link", { name: new RegExp(`^EPM ${stamp} \\$\\s220\\.000 el `) })).toBeVisible();
    });

    test("the month's «Ajuste por cuadre» is tappable and lists the account and its amount", async ({ page }) => {
      const stat = page.getByRole("button", { name: /Ajuste por cuadre del mes/ }).filter({ visible: true });
      await stat.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(names.counted)).toBeVisible();
      await expect(dialog).toContainText("+$ 12.000");
    });
  });
}

test("the count's adjustment stays out of the recent movements", async ({ page }) => {
  await page.goto("/es");
  await expect(page.getByText(names.counted)).toHaveCount(0);
});
