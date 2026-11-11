/**
 * The two report surfaces, neither of which any check had opened: the dashboard's
 * month flow (RF-88) and the reports screen's expenses-by-category breakdown
 * (RF-34) over its six-month series (RF-35). Layer 1 proves the figures the
 * queries return; what it cannot prove is that they reach a screen — the whole
 * next-intl catalogue ships in the page payload, so a heading matches even when
 * nothing rendered.
 *
 * A transfer sits in the same window as the income and the expense, so every
 * figure below is asserted at the value that excludes it (RF-19).
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const dashboard = messages.dashboard;
const reports = messages.reports;

const scope = readScope();

// The income needs a category of its own: a split shares its movement's kind.
const incomeCategoryId = randomUUID();
const incomeCategoryName = `Ingreso reportes ${randomUUID().slice(0, 8)}`;
// The transfer needs a second account, which is what makes it a transfer at all.
const secondAccountId = randomUUID();

const EXPENSE_CENTS = 4_300_000;
const INCOME_CENTS = 9_100_000;
const TRANSFER_CENTS = 5_500_000;
// Last month's expense, inside the six-month window and outside this month's.
const PRIOR_EXPENSE_CENTS = 2_100_000;

// The digits of a rendered amount: the separators and the currency mark are
// `Intl`'s, and the browser's ICU need not agree with Node's.
async function digitsOf(locator: Locator): Promise<string> {
  return ((await locator.innerText()).match(/\d/g) ?? []).join("");
}

// COP shows no decimals, so an integer number of pesos is what a figure reads as.
function pesos(cents: number): string {
  return String(cents / 100);
}

// A dashboard month figure sits under its own label, which carries no digits.
function monthStat(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator("..");
}

/**
 * The band the width displays. Module 36 gave this screen a laptop sibling
 * that repeats the same category-row markup rather than sharing it (the mobile
 * stack stays untouched, per its own additive rule), so both bands are always
 * in the DOM and a locator that names neither reaches a category row twice and
 * dies on strict mode — the same shape `e2e/accounts.spec.ts`'s own `band`
 * already carries.
 */
function band(page: Page): Locator {
  return page.locator("main > .rt-Box").filter({ visible: true });
}

// One bar's drawn height against another's. Both are drawn against the same
// axis, so what comes out is the ratio of the two figures.
async function barRatio(bar: Locator, against: Locator): Promise<number> {
  const [height, other] = await Promise.all([
    bar.getAttribute("height"),
    against.getAttribute("height"),
  ]);

  return Number(height) / Number(other);
}

test.beforeAll(async () => {
  await clearLedger();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${incomeCategoryId}, ${scope.userId}, ${incomeCategoryName}, 'income', '#4C8C4A')`;

    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (
        ${secondAccountId}, ${scope.userId}, 'Cuenta de los reportes', 'asset', 'bank',
        9000000, (now() at time zone ${TIME_ZONE})::date)`;

    const [expense] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${EXPENSE_CENTS},
        (now() at time zone ${TIME_ZONE})::date, 'Harness gasto del mes')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${expense.id}, ${scope.categoryId}, ${EXPENSE_CENTS})`;

    const [income] = await tx<{ id: string }[]>`
      insert into transactions (to_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${INCOME_CENTS},
        (now() at time zone ${TIME_ZONE})::date, 'Harness ingreso del mes')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${income.id}, ${incomeCategoryId}, ${INCOME_CENTS})`;

    // Neither an income nor an expense, and it carries no split (RF-19).
    await tx`
      insert into transactions (
        from_account_id, to_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${secondAccountId}, ${TRANSFER_CENTS},
        (now() at time zone ${TIME_ZONE})::date, 'Harness traslado')`;

    // The last day of the previous month: a second populated bar in the series.
    const [prior] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${PRIOR_EXPENSE_CENTS},
        (date_trunc('month', now() at time zone ${TIME_ZONE}) - interval '1 day')::date,
        'Harness gasto del mes pasado')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${prior.id}, ${scope.categoryId}, ${PRIOR_EXPENSE_CENTS})`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`delete from accounts where id = ${secondAccountId}`;
  await fixtureSql`delete from categories where id = ${incomeCategoryId}`;
});

test("the dashboard reads the month's income, expense and net, the transfer in neither", async ({
  page,
}) => {
  await page.goto("/es");

  expect(await digitsOf(monthStat(page, dashboard.monthIncome))).toBe(
    pesos(INCOME_CENTS),
  );
  expect(await digitsOf(monthStat(page, dashboard.monthExpense))).toBe(
    pesos(EXPENSE_CENTS),
  );
  expect(await digitsOf(monthStat(page, dashboard.monthNet))).toBe(
    pesos(INCOME_CENTS - EXPENSE_CENTS),
  );
});

test("the breakdown reads the month's expense under its category", async ({
  page,
}) => {
  await page.goto("/es/reports");

  const row = band(page).getByText(scope.categoryName, { exact: true }).locator("..");

  await expect(row).toBeVisible();
  // This month's expense alone: last month's split is outside the window and the
  // transfer carries no split at all.
  expect(await digitsOf(row)).toBe(pesos(EXPENSE_CENTS));
});

test("the six-month series draws each month's figures", async ({ page }) => {
  await page.goto("/es/reports");

  const chart = page.getByRole("img", { name: reports.comparisonTitle });
  // The container measures itself before Recharts draws into it.
  await expect(chart.locator("svg")).toBeVisible();

  // The screen's own series colours: jade carries income, violet expense. A month
  // with no movement draws no bar, so these counts are the populated months — and
  // the transfer, which is neither, adds no bar of its own (RF-19).
  const incomeBars = chart.locator('path[fill="var(--jade-9)"]');
  const expenseBars = chart.locator('path[fill="var(--violet-9)"]');

  await expect(incomeBars).toHaveCount(1);
  await expect(expenseBars).toHaveCount(2);

  // A bar's height is linear in the figure behind it, so a ratio of heights is the
  // ratio of the figures. A transfer summed as an expense would lift this month's
  // expense above its income and turn the first ratio upside down.
  await expect
    .poll(() => barRatio(incomeBars.first(), expenseBars.last()))
    .toBeCloseTo(INCOME_CENTS / EXPENSE_CENTS, 2);
  // Oldest first, so the first violet bar is last month's expense.
  await expect
    .poll(() => barRatio(expenseBars.first(), expenseBars.last()))
    .toBeCloseTo(PRIOR_EXPENSE_CENTS / EXPENSE_CENTS, 2);
});

/**
 * RF-138 on the two report surfaces: the month's adjustment (what a
 * reconciliation booked) is its own line, apart from income, expense and net.
 * Written from the plan's M5 Done table and boards B11/B12, before the line exists.
 *
 * A reconciliation is seeded as the person's own insert; the database books the
 * adjustment movement, so no marked movement is ever written here. Every figure
 * is stated from the rows seeded: the account opens today at 10.000 and is
 * counted at 410.000, a gap of +400.000.
 */
const ADJUSTMENT_LABEL = messages.dashboard.monthAdjustment;
const COP_GAP_CENTS = 40_000_000;

function flatText(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

type BookedAccount = { id: string; currency: "COP" | "USD" };

// An account opening today at `openingCents`, then counted `gapCents` above what
// HomeFund derives: the trigger books one adjustment of that size, or none at zero.
async function seedGap(
  currency: "COP" | "USD",
  openingCents: number,
  gapCents: number,
): Promise<BookedAccount> {
  const id = randomUUID();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, settlement_currency,
        initial_balance_cents, initial_balance_on)
      values (
        ${id}, ${scope.userId}, ${`Descuadre ${currency} ${id.slice(0, 8)}`}, 'asset', 'bank',
        ${currency}, ${openingCents}, (now() at time zone ${TIME_ZONE})::date)`;
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${id}, (now() at time zone ${TIME_ZONE})::date, ${openingCents + gapCents})`;
  });

  return { id, currency };
}

async function bookedCents(accountId: string): Promise<string[]> {
  const rows = await fixtureSql<{ amount: string }[]>`
    select amount_cents::text as amount from transactions
    where reconciliation_id is not null
      and (from_account_id = ${accountId} or to_account_id = ${accountId})`;

  return rows.map((row) => row.amount);
}

async function dropGapAccounts(accounts: BookedAccount[]): Promise<void> {
  for (const { id } of accounts) {
    await fixtureSql`
      delete from transactions where from_account_id = ${id} or to_account_id = ${id}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${id}`;
    await fixtureSql`delete from accounts where id = ${id}`;
  }
}

test.describe("a +400.000 adjustment this month", () => {
  let booked: BookedAccount[] = [];

  test.beforeAll(async () => {
    booked = [await seedGap("COP", 1_000_000, COP_GAP_CENTS)];
    // The seed is only as good as what the database booked from it.
    expect(await bookedCents(booked[0].id)).toEqual([String(COP_GAP_CENTS)]);
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
  });

  test("the dashboard's month card reads «Descuadre del mes» +$ 400.000 after the net", async ({
    page,
  }) => {
    await page.goto("/es");

    const stat = monthStat(page, ADJUSTMENT_LABEL);
    await expect(stat).toBeVisible();

    // Raw text: the digits alone would pass with the sign and without it.
    expect(flatText(await stat.innerText())).toContain("+$ 400.000");

    const net = await monthStat(page, dashboard.monthNet).boundingBox();
    const adjustment = await stat.boundingBox();
    expect(net).not.toBeNull();
    expect(adjustment).not.toBeNull();
    // After «Neto del mes»: on the same row to its right, or on the next row.
    const after =
      adjustment!.y > net!.y + net!.height - 1 || adjustment!.x > net!.x + net!.width - 1;
    expect(after).toBe(true);
  });

  test.describe("on a 390 px screen", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the four month stats wrap without overflowing @mobile", async ({ page }) => {
      await page.goto("/es");

      const labels = [
        dashboard.monthIncome,
        dashboard.monthExpense,
        dashboard.monthNet,
        ADJUSTMENT_LABEL,
      ];
      for (const label of labels) {
        await expect(monthStat(page, label)).toBeVisible();
        const box = await monthStat(page, label).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
