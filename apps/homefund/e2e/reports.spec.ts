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

  // The screen's own series colours: jade carries income, tomato expense. A month
  // with no movement draws no bar, so these counts are the populated months — and
  // the transfer, which is neither, adds no bar of its own (RF-19).
  const incomeBars = chart.locator('path[fill="var(--jade-9)"]');
  const expenseBars = chart.locator('path[fill="var(--tomato-9)"]');

  await expect(incomeBars).toHaveCount(1);
  await expect(expenseBars).toHaveCount(2);

  // A bar's height is linear in the figure behind it, so a ratio of heights is the
  // ratio of the figures. A transfer summed as an expense would lift this month's
  // expense above its income and turn the first ratio upside down.
  await expect
    .poll(() => barRatio(incomeBars.first(), expenseBars.last()))
    .toBeCloseTo(INCOME_CENTS / EXPENSE_CENTS, 2);
  // Oldest first, so the first tomato bar is last month's expense.
  await expect
    .poll(() => barRatio(expenseBars.first(), expenseBars.last()))
    .toBeCloseTo(PRIOR_EXPENSE_CENTS / EXPENSE_CENTS, 2);
});

test.describe("a second currency on the dashboard", () => {
  // Held for this describe alone: a USD account in the shared fixture above
  // would draw a second "en USD" band under the two tests that read the COP
  // figures by a bare label, and dying on strict mode is not what proves RF-124.
  const usdAccountId = randomUUID();
  const usdIncomeCategoryId = randomUUID();
  const usdIncomeCategoryName = `Ingreso USD ${randomUUID().slice(0, 8)}`;

  // The stored scale is hundredths of the major unit for every currency alike
  // (RNF-05): $650.00 and $120.00 land as 65000 and 12000, no float involved.
  const USD_OPENING_CENTS = 65_000;
  const USD_INCOME_CENTS = 12_000;

  test.beforeAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${usdIncomeCategoryId}, ${scope.userId}, ${usdIncomeCategoryName}, 'income', '#4C8C4A')`;

      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, settlement_currency,
          initial_balance_cents, initial_balance_on)
        values (
          ${usdAccountId}, ${scope.userId}, 'Cuenta reportes USD', 'asset', 'bank', 'USD',
          ${USD_OPENING_CENTS}, (now() at time zone ${TIME_ZONE})::date)`;

      const [income] = await tx<{ id: string }[]>`
        insert into transactions (to_account_id, amount_cents, occurred_at, description)
        values (
          ${usdAccountId}, ${USD_INCOME_CENTS},
          (now() at time zone ${TIME_ZONE})::date, 'Harness ingreso en dólares')
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${income.id}, ${usdIncomeCategoryId}, ${USD_INCOME_CENTS})`;
    });
  });

  test.afterAll(async () => {
    await fixtureSql`delete from transactions where to_account_id = ${usdAccountId}`;
    await fixtureSql`delete from accounts where id = ${usdAccountId}`;
    await fixtureSql`delete from categories where id = ${usdIncomeCategoryId}`;
  });

  // The band a currency draws its own month figures in (RF-124): "Ingresos del
  // mes" now repeats once per currency the fund holds, so a figure is read from
  // the section that names its own currency, never bare off the page.
  function currencyBlock(page: Page, currency: string): Locator {
    return page
      .getByText(reports.inCurrency.replace("{currency}", currency), { exact: true })
      .locator("..");
  }

  test("draws a second net worth and a second month flow, and neither is the peso figure plus the dollar one", async ({
    page,
  }) => {
    await page.goto("/es");

    // The peso figures still read at what the shared fixture wrote — summed
    // into the dollar income, this would be off by exactly USD_INCOME_CENTS.
    const copIncome = currencyBlock(page, "COP")
      .getByText(dashboard.monthIncome, { exact: true })
      .locator("..");
    expect(await digitsOf(copIncome)).toBe(pesos(INCOME_CENTS));

    const usdIncome = currencyBlock(page, "USD")
      .getByText(dashboard.monthIncome, { exact: true })
      .locator("..");
    expect(await digitsOf(usdIncome)).toBe(String(USD_INCOME_CENTS));

    // Its own net-worth heading, named by the currency alone — no bare label to
    // scope, since no other heading on the page reads "Patrimonio en USD".
    await expect(
      page.getByText(dashboard.netWorthIn.replace("{currency}", "USD"), {
        exact: true,
      }),
    ).toBeVisible();
  });
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
const USD_GAP_CENTS = 2_500;

const MINUS_SIGN = "−";

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

// A dollar income on a fresh account with no reconciliation: it makes the USD band exist.
async function seedUsdIncome(
  categoryId: string,
  categoryName: string,
  cents: number,
): Promise<BookedAccount> {
  const id = randomUUID();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${categoryName}, 'income', '#4C8C4A')`;
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, settlement_currency,
        initial_balance_cents, initial_balance_on)
      values (
        ${id}, ${scope.userId}, ${`Ingreso USD ${id.slice(0, 8)}`}, 'asset', 'bank', 'USD',
        0, (now() at time zone ${TIME_ZONE})::date)`;
    const [income] = await tx<{ id: string }[]>`
      insert into transactions (to_account_id, amount_cents, occurred_at, description)
      values (
        ${id}, ${cents}, (now() at time zone ${TIME_ZONE})::date, 'Harness ingreso en dólares')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${income.id}, ${categoryId}, ${cents})`;
  });

  return { id, currency: "USD" };
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

/**
 * Every line under `root` that names the adjustment, as the text a person reads
 * on it: the label with its amount. The innermost element that carries the label
 * stands for the line; when it holds the label alone, its parent holds the amount.
 */
async function adjustmentLines(root: Locator): Promise<string[]> {
  return root.evaluate((element, label) => {
    const lines: string[] = [];
    const textOf = (node: Element) => (node as HTMLElement).innerText ?? "";

    for (const node of element.querySelectorAll("*")) {
      if (node.tagName === "SCRIPT" || node.tagName === "STYLE") continue;
      const own = textOf(node);
      if (!own.includes(label)) continue;
      if (Array.from(node.children).some((child) => textOf(child).includes(label))) continue;
      lines.push(own.trim() === label ? textOf(node.parentElement!) : own);
    }

    return lines;
  }, ADJUSTMENT_LABEL);
}

// The colour a figure is drawn in: the innermost element that carries its digits.
async function amountColor(stat: Locator): Promise<string> {
  return stat.evaluate((element) => {
    let deepest: Element = element;
    for (const node of element.querySelectorAll("*")) {
      if (/\d/.test((node as HTMLElement).innerText ?? "")) deepest = node;
    }

    return getComputedStyle(deepest).color;
  });
}

function currencyBand(page: Page, currency: string): Locator {
  return page
    .getByText(reports.inCurrency.replace("{currency}", currency), { exact: true })
    .locator("..");
}

test("with no reconciliation, neither surface names the month's adjustment", async ({
  page,
}) => {
  // Control: green before the screens change and must stay green after.
  await page.goto("/es");
  await expect(monthStat(page, dashboard.monthNet)).toBeVisible();
  expect(await adjustmentLines(page.locator("main"))).toEqual([]);

  await page.goto("/es/reports");
  await expect(
    band(page).getByText(scope.categoryName, { exact: true }),
  ).toBeVisible();
  expect(await adjustmentLines(band(page))).toEqual([]);
});

test.describe("a reconciliation with no gap", () => {
  let booked: BookedAccount[] = [];

  test.beforeAll(async () => {
    booked = [await seedGap("COP", 1_000_000, 0)];
    expect(await bookedCents(booked[0].id)).toEqual([]);
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
  });

  test("neither surface draws a line at zero", async ({ page }) => {
    // Control: a zero gap books nothing, so nothing is drawn.
    await page.goto("/es");
    await expect(monthStat(page, dashboard.monthNet)).toBeVisible();
    expect(await adjustmentLines(page.locator("main"))).toEqual([]);

    await page.goto("/es/reports");
    await expect(
      band(page).getByText(scope.categoryName, { exact: true }),
    ).toBeVisible();
    expect(await adjustmentLines(band(page))).toEqual([]);
  });
});

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

  test("the dashboard's adjustment is plain ink, not painted as gain (the income accent)", async ({
    page,
  }) => {
    await page.goto("/es");

    const color = await amountColor(monthStat(page, ADJUSTMENT_LABEL));
    expect(color).not.toBe(await amountColor(monthStat(page, dashboard.monthIncome)));
  });

  test("the dashboard's income, expense and net read what they read without it", async ({
    page,
  }) => {
    await page.goto("/es");
    await expect(monthStat(page, ADJUSTMENT_LABEL)).toBeVisible();

    expect(await digitsOf(monthStat(page, dashboard.monthIncome))).toBe(
      pesos(INCOME_CENTS),
    );
    expect(await digitsOf(monthStat(page, dashboard.monthExpense))).toBe(
      pesos(EXPENSE_CENTS),
    );
    expect(await digitsOf(monthStat(page, dashboard.monthNet))).toBe(
      pesos(INCOME_CENTS - EXPENSE_CENTS),
    );
    // A net that took the adjustment in would have lost its sign test too:
    // 91.000 - 43.000 + 400.000 reads 448.000.
    expect(flatText(await monthStat(page, dashboard.monthNet).innerText())).not.toContain(
      "448.000",
    );
  });

  test("the reports screen reads «Descuadre del mes» +$ 400.000 under the breakdown", async ({
    page,
  }) => {
    await page.goto("/es/reports");

    const row = band(page).getByText(scope.categoryName, { exact: true });
    await expect(row).toBeVisible();

    const lines = await adjustmentLines(band(page));
    expect(lines).toHaveLength(1);
    expect(flatText(lines[0])).toContain("+$ 400.000");

    const line = band(page).getByText(ADJUSTMENT_LABEL, { exact: false }).first();
    const rowBox = await row.boundingBox();
    const lineBox = await line.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(lineBox).not.toBeNull();
    expect(lineBox!.y).toBeGreaterThan(rowBox!.y);
  });

  test("the reports breakdown and the month's category row read what they read without it", async ({
    page,
  }) => {
    await page.goto("/es/reports");

    const row = band(page).getByText(scope.categoryName, { exact: true }).locator("..");
    await expect(row).toBeVisible();
    expect(await digitsOf(row)).toBe(pesos(EXPENSE_CENTS));

    // The adjustment is not a category: the one expense category is the only row.
    await expect(
      band(page).getByText(/^Diferencia$/, { exact: true }),
    ).toHaveCount(0);
  });

  test("the six-month chart still draws two series: no third legend, no third bar colour, no lifted income bar", async ({
    page,
  }) => {
    await page.goto("/es/reports");

    const chart = page.getByRole("img", { name: /Últimos 6 meses en COP/ });
    await expect(chart.locator("svg")).toBeVisible();

    // The legend names income and expense for the currency, and nothing else.
    await expect(band(page).getByText(/ en COP$/)).toHaveCount(2);
    await expect(
      band(page).getByText(`${reports.legendIncome} en COP`, { exact: true }),
    ).toBeVisible();
    await expect(
      band(page).getByText(`${reports.legendExpense} en COP`, { exact: true }),
    ).toBeVisible();

    const incomeBars = chart.locator('path[fill="var(--jade-9)"]');
    const expenseBars = chart.locator('path[fill="var(--tomato-9)"]');
    await expect(incomeBars).toHaveCount(1);
    await expect(expenseBars).toHaveCount(2);
    // Every bar is one of the two series' colours.
    await expect(chart.locator('path[fill^="var(--"]')).toHaveCount(3);

    // An income bar that took the adjustment in would stand 5x its figure.
    await expect
      .poll(() => barRatio(incomeBars.first(), expenseBars.last()))
      .toBeCloseTo(INCOME_CENTS / EXPENSE_CENTS, 2);
  });

  test.describe("on a 390 px screen", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the four month stats wrap without overflowing", async ({ page }) => {
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

test.describe("a negative adjustment", () => {
  let booked: BookedAccount[] = [];

  test.beforeAll(async () => {
    booked = [await seedGap("COP", 5_000_000, -1_500_000)];
    expect(await bookedCents(booked[0].id)).toEqual(["1500000"]);
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
  });

  test("both surfaces read it with the minus sign, never the hyphen", async ({ page }) => {
    await page.goto("/es");
    const stat = monthStat(page, ADJUSTMENT_LABEL);
    await expect(stat).toBeVisible();
    expect(flatText(await stat.innerText())).toContain(`${MINUS_SIGN}$ 15.000`);

    await page.goto("/es/reports");
    await expect(
      band(page).getByText(scope.categoryName, { exact: true }),
    ).toBeVisible();
    const lines = await adjustmentLines(band(page));
    expect(lines).toHaveLength(1);
    expect(flatText(lines[0])).toContain(`${MINUS_SIGN}$ 15.000`);
  });

  test("the six-month chart's expense bar stands at the month's spend, not spend plus the count that came up short", async ({
    page,
  }) => {
    // Seeded: income 91.000, expense 43.000, prior month's expense 21.000, and a
    // -15.000 adjustment. An expense bar that took the adjustment in stands at
    // 58.000, which reads income:expense as 1.57 instead of 2.12.
    await page.goto("/es/reports");

    const chart = page.getByRole("img", { name: /Últimos 6 meses en COP/ });
    await expect(chart.locator("svg")).toBeVisible();
    const incomeBars = chart.locator('path[fill="var(--jade-9)"]');
    const expenseBars = chart.locator('path[fill="var(--tomato-9)"]');
    await expect(expenseBars).toHaveCount(2);

    await expect
      .poll(() => barRatio(incomeBars.first(), expenseBars.last()))
      .toBeCloseTo(INCOME_CENTS / EXPENSE_CENTS, 2);
    await expect
      .poll(() => barRatio(expenseBars.first(), expenseBars.last()))
      .toBeCloseTo(PRIOR_EXPENSE_CENTS / EXPENSE_CENTS, 2);
  });
});

test.describe("an adjustment in dollars alone", () => {
  let booked: BookedAccount[] = [];
  const usdIncomeCategoryId = randomUUID();
  const usdIncomeCategoryName = `Ingreso USD ${randomUUID().slice(0, 8)}`;
  const USD_INCOME = 12_000;

  test.beforeAll(async () => {
    booked = [await seedGap("USD", 10_000, USD_GAP_CENTS)];
    expect(await bookedCents(booked[0].id)).toEqual([String(USD_GAP_CENTS)]);

    // The dollar band exists with or without an adjustment: it holds an income, on
    // an account of its own so no movement is dated at or before the reconciliation.
    booked.push(await seedUsdIncome(usdIncomeCategoryId, usdIncomeCategoryName, USD_INCOME));
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
    await fixtureSql`delete from categories where id = ${usdIncomeCategoryId}`;
  });

  test("the dashboard shows it in the USD band and not in the peso band", async ({ page }) => {
    await page.goto("/es");

    const usd = currencyBand(page, "USD");
    const cop = currencyBand(page, "COP");
    await expect(usd).toBeVisible();

    const usdLines = await adjustmentLines(usd);
    expect(usdLines).toHaveLength(1);
    expect(usdLines[0]).toContain("+");
    expect((usdLines[0].match(/\d/g) ?? []).join("")).toBe(String(USD_GAP_CENTS));

    // The peso band has no adjustment of its own, so it names none.
    expect(await adjustmentLines(cop)).toEqual([]);
    // The dollar income still reads its own figure, unmixed with the gap.
    expect(
      await digitsOf(usd.getByText(dashboard.monthIncome, { exact: true }).locator("..")),
    ).toBe(String(USD_INCOME));
  });

  test("the reports screen draws one line, in dollars", async ({ page }) => {
    await page.goto("/es/reports");
    await expect(band(page).getByText(scope.categoryName, { exact: true })).toBeVisible();

    const lines = await adjustmentLines(band(page));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("+");
    expect((lines[0].match(/\d/g) ?? []).join("")).toBe(String(USD_GAP_CENTS));
  });
});

test.describe("an adjustment in each currency", () => {
  let booked: BookedAccount[] = [];
  const usdIncomeCategoryId = randomUUID();

  test.beforeAll(async () => {
    booked = [
      await seedGap("COP", 1_000_000, COP_GAP_CENTS),
      await seedGap("USD", 10_000, USD_GAP_CENTS),
      await seedUsdIncome(usdIncomeCategoryId, `Ingreso USD ${usdIncomeCategoryId.slice(0, 8)}`, 12_000),
    ];
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
    await fixtureSql`delete from categories where id = ${usdIncomeCategoryId}`;
  });

  test("the dashboard reads each in its own band, never summed", async ({ page }) => {
    await page.goto("/es");

    const cop = await adjustmentLines(currencyBand(page, "COP"));
    const usd = await adjustmentLines(currencyBand(page, "USD"));

    expect(cop).toHaveLength(1);
    expect(flatText(cop[0])).toContain("+$ 400.000");
    expect(usd).toHaveLength(1);
    expect((usd[0].match(/\d/g) ?? []).join("")).toBe(String(USD_GAP_CENTS));
  });

  test("the reports screen draws one line per currency", async ({ page }) => {
    await page.goto("/es/reports");
    await expect(band(page).getByText(scope.categoryName, { exact: true })).toBeVisible();

    const lines = (await adjustmentLines(band(page))).map(
      (line) => (line.match(/\d/g) ?? []).join(""),
    );
    expect(lines.sort()).toEqual([String(USD_GAP_CENTS), pesos(COP_GAP_CENTS)].sort());
  });
});

test.describe("the month card holds four figures on a laptop", () => {
  let booked: BookedAccount[] = [];

  test.beforeAll(async () => {
    booked = [await seedGap("COP", 50_000_000, -46_900_000)];
    expect(await bookedCents(booked[0].id)).toEqual(["46900000"]);
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
  });

  for (const width of [1024, 1280, 1440]) {
    test(`at ${width} px no figure overlaps, clips or breaks a word`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the card is the laptop's");
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/es");
      await expect(monthStat(page, ADJUSTMENT_LABEL)).toBeVisible();

      const labels = [
        dashboard.monthIncome,
        dashboard.monthExpense,
        dashboard.monthNet,
        ADJUSTMENT_LABEL,
      ];

      const report = await page.locator('[data-card="month"]').evaluate((card, names) => {
        type Box = { left: number; top: number; right: number; bottom: number };
        const box = (rect: DOMRect): Box => ({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
        const cardBox = box(card.getBoundingClientRect());
        const issues: string[] = [];
        const boxes: { name: string; box: Box }[] = [];

        for (const name of names) {
          const label = Array.from(card.querySelectorAll("*")).find(
            (node) => node.children.length === 0 && node.textContent === name,
          ) as HTMLElement | undefined;
          if (!label) {
            issues.push(`${name}: missing`);
            continue;
          }
          const figure = label.nextElementSibling as HTMLElement;

          for (const [part, node] of [
            ["label", label],
            ["figure", figure],
          ] as const) {
            const b = box(node.getBoundingClientRect());
            boxes.push({ name: `${name} ${part}`, box: b });
            if (
              b.left < cardBox.left - 0.5 ||
              b.right > cardBox.right + 0.5 ||
              b.top < cardBox.top - 0.5 ||
              b.bottom > cardBox.bottom + 0.5
            ) {
              issues.push(`${name} ${part}: outside the card`);
            }
          }
          // A figure wider than its stat spills out of it; the stat is the block that scrolls.
          const stat = label.parentElement as HTMLElement;
          if (stat.scrollWidth > stat.clientWidth) issues.push(`${name}: figure clipped`);
          if (box(figure.getBoundingClientRect()).right > box(stat.getBoundingClientRect()).right + 0.5) {
            issues.push(`${name}: figure spills out of its stat`);
          }

          // A word broken across lines has characters at two heights.
          const text = label.firstChild as Text;
          const range = document.createRange();
          let offset = 0;
          for (const word of name.split(" ")) {
            const tops = new Set<number>();
            for (let i = 0; i < word.length; i += 1) {
              range.setStart(text, offset + i);
              range.setEnd(text, offset + i + 1);
              tops.add(Math.round(range.getBoundingClientRect().top));
            }
            if (tops.size > 1) issues.push(`${name}: «${word}» is broken`);
            offset += word.length + 1;
          }
        }

        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i].box;
            const b = boxes[j].box;
            const overlaps =
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
            if (overlaps) issues.push(`${boxes[i].name} overlaps ${boxes[j].name}`);
          }
        }

        return issues;
      }, labels);

      expect(report).toEqual([]);
      expect(flatText(await monthStat(page, ADJUSTMENT_LABEL).innerText())).toContain(
        `${MINUS_SIGN}$ 469.000`,
      );
    });
  }
});

test.describe("each currency's adjustment sits under its own expense breakdown (B12)", () => {
  let booked: BookedAccount[] = [];
  const usdIncomeCategoryId = randomUUID();

  test.beforeAll(async () => {
    booked = [
      await seedGap("COP", 1_000_000, COP_GAP_CENTS),
      await seedGap("USD", 10_000, USD_GAP_CENTS),
      await seedUsdIncome(usdIncomeCategoryId, `Ingreso USD ${usdIncomeCategoryId.slice(0, 8)}`, 12_000),
    ];
  });

  test.afterAll(async () => {
    await dropGapAccounts(booked);
    await fixtureSql`delete from categories where id = ${usdIncomeCategoryId}`;
  });

  test("the line of a currency follows that currency's heading, not the last one", async ({
    page,
  }) => {
    await page.goto("/es/reports");
    await expect(band(page).getByText(scope.categoryName, { exact: true })).toBeVisible();

    const owners = await band(page).evaluate(
      (root, args) => {
        const headings = new Map<Element, string>();
        for (const currency of args.currencies) {
          const text = args.heading.replace("{currency}", currency);
          for (const node of root.querySelectorAll("*")) {
            if (node.children.length === 0 && node.textContent === text) {
              headings.set(node, currency);
            }
          }
        }
        // The group that holds a heading is the currency's band; the line must sit in it.
        const result: { currency: string; digits: string }[] = [];
        for (const [heading, currency] of headings) {
          const group = heading.parentElement!;
          for (const node of group.querySelectorAll("*")) {
            if (node.children.length === 0 && node.textContent === args.label) {
              result.push({
                currency,
                digits: ((node.parentElement!.textContent ?? "").match(/\d/g) ?? []).join(""),
              });
            }
          }
        }
        return result;
      },
      {
        currencies: ["COP", "USD"],
        heading: reports.inCurrency,
        label: ADJUSTMENT_LABEL,
      },
    );

    expect(owners).toContainEqual({ currency: "COP", digits: pesos(COP_GAP_CENTS) });
    expect(owners).toContainEqual({ currency: "USD", digits: String(USD_GAP_CENTS) });
    expect(owners.filter((o) => o.currency === "COP")).toHaveLength(1);
    expect(owners.filter((o) => o.currency === "USD")).toHaveLength(1);
  });
});
