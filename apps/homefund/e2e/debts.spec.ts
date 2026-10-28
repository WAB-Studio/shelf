/**
 * The consolidated debts screen, which no check had opened (RF-83): the total
 * owed across every liability, each card's available credit and the summed
 * estimated monthly interest. Layer 1 proves what `getDebtsScreenData` returns;
 * what it cannot prove is that the figures reach the screen — the whole next-intl
 * catalogue ships in the page payload, so a heading matches even when nothing
 * rendered.
 *
 * Two liabilities, only one of them carrying terms, so the total is a sum of
 * both while the interest comes from the one with a rate.
 *
 * What the describes below add is everything no server-side check reaches: the
 * two bands at the two widths, the row menus, the dialogs they open, the detail
 * route's three tables, and the same screens driven by an identity the database
 * would refuse every write to. Every case is asserted against a figure the screen
 * rendered or the accessible name of a control it offered — never against a
 * heading the shipped catalogue would match on an empty page.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";

import messages from "@/messages/es.json";
import { addCivilDays, addCivilMonths, todayInBogota } from "@/lib/dates";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  MEMBER_STORAGE_STATE,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const debts = messages.debts;
const installments = messages.installments;
const common = messages.common;
const settlement = messages.debts.settlement;

// The em dash a cell with nothing to name reads as, which is what a debt with no
// credit limit shows instead of a cupo of zero (RF-117).
const NO_VALUE = "\u2014";

// The minus `Money` prints on a signed figure below zero (SPEC-A3), read back
// here to tell a negative gap from a positive one without importing the
// component that draws it.
const MINUS = "\u2212";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const cardId = randomUUID();
const cardName = `Tarjeta deudas ${stamp}`;
const bareId = randomUUID();
const bareName = `Deuda sin términos ${stamp}`;

// Every balance is derived, so the opening figure of a liability is what it owes,
// stored negative (RNF-05).
const CARD_OWED_CENTS = 120_000_000;
const BARE_OWED_CENTS = 45_000_000;
const CREDIT_LIMIT_CENTS = 300_000_000;
const ANNUAL_RATE = 0.24;
const MINIMUM_PAYMENT_CENTS = 6_000_000;

// The effective twelfth-root step of the annual rate, never the linear rate/12
// (RF-79). Postgres rounds the same product in `numeric`, so the screen may land
// one cent away from this — a peso apart at the very most.
const MONTHLY_INTEREST_CENTS = Math.round(
  CARD_OWED_CENTS * ((1 + ANNUAL_RATE) ** (1 / 12) - 1),
);

// The digits of a rendered amount: the separators and the currency mark are
// `Intl`'s, and the browser's ICU need not agree with Node's.
async function digitsOf(locator: Locator): Promise<number> {
  return digitsIn(await locator.innerText());
}

function digitsIn(text: string): number {
  return Number((text.match(/\d/g) ?? []).join(""));
}

// COP shows no decimals, so an integer number of pesos is what a figure reads as.
function pesos(cents: number): number {
  return cents / 100;
}

/**
 * The band the width displays. Both are in the DOM at every width and they carry
 * the same words — `debts.total` and `debts.tileTotal` are one string — so a
 * locator that does not name a band matches twice and dies on strict mode.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const today = tx`(now() at time zone ${TIME_ZONE})::date`;

    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${cardId}, ${scope.userId}, ${cardName}, 'liability', 'card',
          ${-CARD_OWED_CENTS}, ${today}),
        (${bareId}, ${scope.userId}, ${bareName}, 'liability', 'card',
          ${-BARE_OWED_CENTS}, ${today})`;

    // Only the first carries terms; the other owes without a rate (RF-78, RF-79).
    await tx`
      insert into debt_terms (
        account_id, debt_kind, annual_rate, minimum_payment_cents,
        credit_limit_cents, statement_cut_off_day, payment_due_day)
      values (
        ${cardId}, 'revolving', ${ANNUAL_RATE}, ${MINIMUM_PAYMENT_CENTS},
        ${CREDIT_LIMIT_CENTS}, 15, 5)`;
  });
});

test.afterAll(async () => {
  // Under the caller's claims, so the trail rows this drop stamps name an actor
  // the next run's purge can find again.
  await asHarnessUser(async (tx) => {
    await tx`delete from debt_terms where account_id = ${cardId}`;
    await tx`delete from accounts where id in ${tx([cardId, bareId])}`;
  });
});

test("the consolidated view totals both debts and carries the card's own figures", async ({
  page,
}) => {
  const laptop = (page.viewportSize()?.width ?? 0) >= 1024;
  const shown = band(page);

  // The figure right under the label — the phone's heading, the laptop's tile
  // value: what every debt of the fund owes, the bare one included, and the
  // interest only the debts with a rate contribute to. A total that dropped the
  // bare debt would read short of the database's sum.
  const total = laptop
    ? pesoTile(shown, debts.tileTotal)
    : shown
        .getByText(new RegExp(`^${debts.total}`))
        .first()
        .locator("xpath=following-sibling::*[1]");
  const interest = laptop
    ? pesoTile(shown, debts.tileMonthlyInterest)
    : shown.getByText(debts.monthlyInterest.split("{")[0].trim()).first();

  await expectFundTotals(async () => {
    await page.goto("/es/planning/debts");
    await expect(total).toBeVisible();
    return {
      owed: await digitsOf(total),
      interest: await digitsOf(interest),
      ...(laptop
        ? { available: await digitsOf(pesoTile(shown, debts.tileAvailableCredit)) }
        : {}),
    };
  });

  // Both liabilities are on screen: a card each on the phone, a row each on the
  // laptop, wherever the table's pages put it.
  for (const name of [cardName, bareName]) {
    await page.goto("/es/planning/debts");
    if (laptop) await pageToRow(page, name);
    await expect(band(page).getByText(name, { exact: true })).toBeVisible();
  }

  // The card's own cupo: the limit less what it owes. The bare debt has no
  // limit to lift the fund's.
  const ownCupo = laptop
    ? page
        .getByRole("table", { name: debts.title })
        .getByRole("row")
        .filter({ hasText: cardName })
        .getByRole("cell")
        .nth(1)
    : phoneCard(page, cardName, cardId).getByText(
        debts.availableCredit.split("{")[0].trim(),
      );
  await page.goto("/es/planning/debts");
  if (laptop) await pageToRow(page, cardName);
  expect(await digitsOf(ownCupo)).toBe(pesos(CREDIT_LIMIT_CENTS - CARD_OWED_CENTS));
});

// The menu names the row it acts on, so a debt is reached by its own name and
// never by a position among whatever else the table is carrying.
function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

// The `other` branch of an ICU plural with `#` filled, which is what a count
// renders as on screen once it leaves the catalogue.
function atCount(message: string, count: number): string {
  const branch = /other \{([^}]*)\}/.exec(message)?.[1] ?? message;
  return branch.replace("#", String(count));
}

// A plan's position as the list states it, paid over total (RF-81).
function positionText(paid: number, total: number): string {
  return debts.installmentPosition
    .replace("{paid}", String(paid))
    .replace("{total}", String(total));
}

/**
 * The figure a tile states under its label. Several labels are also column
 * headers of the table below them and one is also the badge on a row, so the
 * match is narrowed to the sibling that actually carries digits.
 */
function tileValue(scope: Locator, label: string): Locator {
  return scope
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::*[1]")
    .filter({ hasText: /\d/ });
}

/**
 * What the fund's peso set adds up to, read off the database at assert time and
 * in whole pesos. Both projects, and every repeat, seed debts for this one user,
 * so no constant of this file is the screen's total; a test proves the screen
 * against this instead. Every figure is folded the way the screen states it: a
 * pocket in credit owes nothing, the interest is struck on what the settlement
 * pocket owes, the cupo is the limit plus the signed settlement pocket.
 */
type FundTotals = { owed: number; interest: number; available: number };

async function fundTotalsNow(): Promise<FundTotals> {
  let totals: FundTotals = { owed: 0, interest: 0, available: 0 };
  await asHarnessUser(async (tx) => {
    const [row] = await tx<{ owed: string; interest: string; available: string }[]>`
      select
        coalesce(sum(greatest(0, -b.balance_cents)), 0)::text as owed,
        coalesce(sum(round(greatest(0, -b.balance_cents) * (power(1 + dt.annual_rate, 1.0 / 12) - 1)))
          filter (where dt.account_id is not null and b.currency = a.settlement_currency), 0)::text as interest,
        coalesce(sum(dt.credit_limit_cents + b.balance_cents)
          filter (where dt.credit_limit_cents is not null and b.currency = a.settlement_currency), 0)::text as available
      from account_balances b
      join accounts a on a.id = b.id
      left join debt_terms dt on dt.account_id = a.id
      where a.kind = 'liability' and a.archived_at is null and b.currency = 'COP'
        and a.owner_user_id = ${scope.userId}`;
    totals = {
      owed: pesos(Number(row.owed)),
      interest: pesos(Number(row.interest)),
      available: pesos(Number(row.available)),
    };
  });
  return totals;
}

/**
 * Loads and reads the screen between two readings of the fund's totals, until
 * what it read equals one of them. The render falls between the two, so it
 * names one unless another seed landed in the window, and the poll then takes
 * it again. Each interest is rounded in `numeric` before the sum, so it may land
 * a peso or two away; the other figures match exactly.
 */
async function expectFundTotals(
  read: () => Promise<Partial<FundTotals>>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = await fundTotalsNow();
        const shown = await read();
        const after = await fundTotalsNow();
        const matches = (expected: FundTotals) =>
          (shown.owed === undefined || shown.owed === expected.owed) &&
          (shown.available === undefined || shown.available === expected.available) &&
          (shown.interest === undefined ||
            Math.abs(shown.interest - expected.interest) <= 2);
        return [before, after].some(matches)
          ? "match"
          : JSON.stringify({ shown, before, after });
      },
      { timeout: 25_000 },
    )
    .toBe("match");
}

/**
 * The peso set's figure under a laptop tile label. A fund holding a second
 * currency draws a set per currency in code order, so the pesos come first.
 */
function pesoTile(shown: Locator, label: string): Locator {
  return tileValue(shown, label).first();
}

/**
 * Pages the laptop table forward until it draws the named row. It holds ten
 * debts a page, and the other project's seeds share this user's list, so a row
 * of ours may sit past the first page.
 */
async function pageToRow(page: Page, name: string): Promise<void> {
  const table = page.getByRole("table", { name: debts.title });
  const next = page.getByRole("button", { name: debts.nextPage, exact: true });
  await expect(table).toBeVisible();

  while ((await table.getByRole("row").filter({ hasText: name }).count()) === 0) {
    if (!(await next.isVisible()) || (await next.isDisabled())) return;
    await next.click();
  }
}

/**
 * A debt's whole phone card: the nearest box around its name that also holds
 * the door to that debt's own detail.
 */
function phoneCard(page: Page, name: string, id: string): Locator {
  return band(page)
    .getByText(name, { exact: true })
    .locator(`xpath=ancestor::*[.//a[@href="/es/planning/debts/${id}"]][1]`);
}

/**
 * The detail door a phone card carries. Named twice over — by the copy the row
 * menu already uses and by the route of that debt — so a control that reads
 * right but leads to the list is not a match.
 */
function cardDetailLink(page: Page, accountId: string): Locator {
  return band(page)
    .getByRole("link", { name: debts.rowDetail, exact: true })
    .and(page.locator(`a[href="/es/planning/debts/${accountId}"]`));
}

// The owed a phone card states: the head puts the name in a column and the
// amount right after it.
function cardOwed(page: Page, name: string): Locator {
  return band(page)
    .getByText(name, { exact: true })
    .locator("xpath=../following-sibling::*[1]");
}

/**
 * The open period's own balance, read inside the panel that names it: the same
 * word labels the statements column and the detail's first tile, and only this
 * one moves with a movement recorded after the last cut-off. The heading
 * sits in the panel's head, so the panel is two levels up.
 */
function openPeriodBalance(page: Page): Locator {
  return page
    .getByRole("heading", { name: installments.currentPeriod, exact: true })
    .locator("xpath=../..")
    .getByText(installments.statementBalance, { exact: true })
    .locator("xpath=following-sibling::*[1]");
}

/**
 * One column of a `DataTable`, as text, over the rows carrying exactly `columns`
 * cells — which is what leaves the caption, the column headers and the totals
 * row out of a reading of the data.
 */
async function readColumn(
  table: Locator,
  index: number,
  columns: number,
): Promise<string[]> {
  const rows = table.getByRole("row");
  const total = await rows.count();
  const values: string[] = [];

  for (let at = 0; at < total; at++) {
    const cells = rows.nth(at).getByRole("cell");
    if ((await cells.count()) !== columns) continue;
    values.push((await cells.nth(index).innerText()).trim());
  }

  return values;
}

/**
 * Every data row of the Deudas table, each as its cells' text, over all its
 * pages. The client pages the rows it already holds, so the reading is one
 * render however many pages it spans.
 */
async function readAllRows(page: Page, columns: number): Promise<string[][]> {
  const table = page.getByRole("table", { name: debts.title });
  const next = page.getByRole("button", { name: debts.nextPage, exact: true });
  const read: string[][] = [];

  for (;;) {
    const rows = table.getByRole("row");
    const total = await rows.count();
    for (let at = 0; at < total; at++) {
      const cells = rows.nth(at).getByRole("cell");
      if ((await cells.count()) !== columns) continue;
      read.push(await cells.allInnerTexts());
    }
    if (!(await next.isVisible()) || (await next.isDisabled())) return read;
    await next.click();
  }
}

type SeededTerms = {
  debtKind: "revolving" | "installment";
  annualRate: number;
  minimumPaymentCents?: number;
  creditLimitCents?: number;
  cutOffDay?: number;
  dueDay?: number;
};

// A liability opens owing, stored negative, so net worth stays a plain sum
// (RNF-05); the terms are optional, and a debt without them owes without a rate.
async function seedDebt({
  id,
  name,
  owedCents,
  openedOn,
  terms,
}: {
  id: string;
  name: string;
  owedCents: number;
  openedOn?: string;
  terms?: SeededTerms;
}): Promise<void> {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (
        ${id}, ${scope.userId}, ${name}, 'liability', 'card',
        ${-owedCents}, ${openedOn ?? todayInBogota()})`;

    if (terms === undefined) return;

    await tx`
      insert into debt_terms (
        account_id, debt_kind, annual_rate, minimum_payment_cents,
        credit_limit_cents, statement_cut_off_day, payment_due_day)
      values (
        ${id}, ${terms.debtKind}, ${terms.annualRate},
        ${terms.minimumPaymentCents ?? null}, ${terms.creditLimitCents ?? null},
        ${terms.cutOffDay ?? null}, ${terms.dueDay ?? null})`;
  });
}

async function seedAsset({
  id,
  name,
  openingCents,
  openedOn,
}: {
  id: string;
  name: string;
  openingCents: number;
  openedOn?: string;
}): Promise<void> {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (
        ${id}, ${scope.userId}, ${name}, 'asset', 'bank',
        ${openingCents}, ${openedOn ?? todayInBogota()})`;
  });
}

// A transfer that credits the liability, the shape a debt payment takes (RF-16);
// it carries no split, which only an expense must.
async function seedPayment({
  fromId,
  toId,
  amountCents,
  occurredAt,
}: {
  fromId: string;
  toId: string;
  amountCents: number;
  occurredAt: string;
}): Promise<string> {
  let id = "";

  await asHarnessUser(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into transactions (
        from_account_id, to_account_id, amount_cents, occurred_at, description)
      values (
        ${fromId}, ${toId}, ${amountCents}, ${occurredAt}, ${`Abono ${stamp}`})
      returning id`;
    id = row.id;
  });

  return id;
}

// A plan whose first `paidLines` lines are settled by one movement, which is the
// shape the FIFO allocation leaves behind (RF-82).
async function seedPlan({
  accountId,
  merchant,
  lines,
  amountCents,
  startDate,
  paidLines = 0,
  paidTransactionId = null,
}: {
  accountId: string;
  merchant: string;
  lines: number;
  amountCents: number;
  startDate: string;
  paidLines?: number;
  paidTransactionId?: string | null;
}): Promise<void> {
  await asHarnessUser(async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      insert into installment_plans (
        account_id, merchant, principal_cents, n_installments, frequency, start_date)
      values (
        ${accountId}, ${merchant}, ${lines * amountCents}, ${lines}, 'monthly',
        ${startDate})
      returning id`;

    await tx`
      insert into installment_lines (
        plan_id, seq, due_date, amount_cents, paid_transaction_id)
      select
        ${plan.id},
        g.seq,
        (${startDate}::date + ((g.seq - 1) || ' month')::interval)::date,
        ${amountCents},
        case when g.seq <= ${paidLines} then ${paidTransactionId}::uuid else null end
      from generate_series(1, ${lines}) as g(seq)`;
  });
}

// Child before parent: the plan's lines ride its cascade, and a movement naming
// an account is what makes that account's deletion fail rather than cascade.
async function dropAccounts(ids: string[]): Promise<void> {
  // Under the caller's claims, so the trail rows this drop stamps name an actor
  // the next run's purge can find again.
  await asHarnessUser(async (tx) => {
    await tx`delete from installment_plans where account_id in ${tx(ids)}`;
    await tx`delete from account_statements where account_id in ${tx(ids)}`;
    await tx`delete from debt_terms where account_id in ${tx(ids)}`;
    await tx`
      delete from transactions
      where from_account_id in ${tx(ids)} or to_account_id in ${tx(ids)}`;
    await tx`delete from accounts where id in ${tx(ids)}`;
  });
}

const SECOND_OWED_CENTS = 50_000_000;
const SECOND_LIMIT_CENTS = 200_000_000;
const SECOND_ANNUAL_RATE = 0.36;
const SECOND_INTEREST_CENTS = Math.round(
  SECOND_OWED_CENTS * ((1 + SECOND_ANNUAL_RATE) ** (1 / 12) - 1),
);

test.describe("the laptop band", () => {
  // The dense table and its tiles render from `lg` up, and both projects drive
  // this describe at the width the artboard states rather than skipping one of
  // them (SPEC-A3, RNF-08).
  test.use({ viewport: { width: 1280, height: 900 } });

  const secondId = randomUUID();
  const secondName = `Tarjeta con cupo ${stamp}`;

  // A second debt carrying a limit, so the cupo tile sums a column rather than
  // repeating one cell, and a second rate so the interest tile sums two.
  test.beforeAll(async () => {
    await seedDebt({
      id: secondId,
      name: secondName,
      owedCents: SECOND_OWED_CENTS,
      terms: {
        debtKind: "revolving",
        annualRate: SECOND_ANNUAL_RATE,
        creditLimitCents: SECOND_LIMIT_CENTS,
      },
    });
  });

  test.afterAll(async () => {
    await dropAccounts([secondId]);
  });

  test("displays itself alone and states the four derived figures, the cupo tile summing its own column", async ({
    page,
  }) => {
    const shown = band(page);
    const table = page.getByRole("table", { name: debts.title });

    // What the fund owes, the interest of the debts that carry a rate, and the
    // cupo of the ones that carry a limit, read off the database at assert time:
    // both projects seed this user's debts, so this describe's are only part of
    // them.
    await expectFundTotals(async () => {
      await page.goto("/es/planning/debts");
      await expect(table).toBeVisible();
      return {
        owed: await digitsOf(pesoTile(shown, debts.tileTotal)),
        interest: await digitsOf(pesoTile(shown, debts.tileMonthlyInterest)),
        available: await digitsOf(pesoTile(shown, debts.tileAvailableCredit)),
      };
    });

    // Exactly one of the two bands is displayed at any width, and at 1280 it is
    // the one carrying the table.
    await expect(band(page)).toHaveCount(1);

    // Everything below reads the one render the poll settled on: the tiles, and
    // the table's every page, which the client pages without a new read.
    const tiles = {
      available: await digitsOf(pesoTile(shown, debts.tileAvailableCredit)),
      nextPayment: await digitsOf(pesoTile(shown, debts.tileNextPayment)),
      note: await shown
        .getByText(debts.tileNextPayment, { exact: true })
        .first()
        .locator("xpath=following-sibling::*[2]")
        .innerText(),
    };
    const rows = await readAllRows(page, 8);
    const named = (name: string) =>
      rows.find((cells) => cells[0].split("\n")[0].trim() === name);

    // The consolidated next payment is the minimum of the row that carries the
    // badge, and the note under the figure names that row (RF-83). Alone, that
    // row is the card: the only debt of this file naming a payment day.
    const badged = rows.filter((cells) => cells[0].includes(debts.nextPaymentBadge));
    expect(badged).toHaveLength(1);
    const badgedName = badged[0][0].split("\n")[0].trim();
    expect(tiles.note.endsWith(badgedName)).toBe(true);
    expect(tiles.nextPayment).toBe(digitsIn(badged[0][3]));
    expect(named(cardName)).toBeDefined();
    expect(digitsIn(named(cardName)![3])).toBe(pesos(MINIMUM_PAYMENT_CENTS));

    // Each cupo is its own limit less what it owes, and the debt with no limit
    // reads absent rather than spent (RF-117).
    expect(digitsIn(named(cardName)![1])).toBe(pesos(CREDIT_LIMIT_CENTS - CARD_OWED_CENTS));
    expect(digitsIn(named(secondName)![1])).toBe(
      pesos(SECOND_LIMIT_CENTS - SECOND_OWED_CENTS),
    );
    expect(named(bareName)![1].trim()).toBe(NO_VALUE);

    // Each row's interest is the effective twelfth-root step of its rate, never
    // the linear rate/12 (RF-79), a peso either side for the `numeric` rounding.
    expect(
      Math.abs(digitsIn(named(cardName)![2]) - pesos(MONTHLY_INTEREST_CENTS)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(digitsIn(named(secondName)![2]) - pesos(SECOND_INTEREST_CENTS)),
    ).toBeLessThanOrEqual(1);

    // And the tile is the sum of the peso cells beneath it, over every page.
    expect(
      rows
        .map((cells) => cells[1])
        .filter((cell) => /\d/.test(cell) && !cell.includes("US$"))
        .reduce((sum, cell) => sum + digitsIn(cell), 0),
    ).toBe(tiles.available);
  });
});

const MENU_DEBT_OWED_CENTS = 100_000_000;
const MENU_LINE_CENTS = 10_000_000;
const MENU_PAID_CENTS = 25_000_000;

test.describe("the row menus", () => {
  // A row menu is the dense table's alone: nothing below `lg` mounts one.
  test.use({ viewport: { width: 1280, height: 900 } });

  const sourceId = randomUUID();
  const sourceName = `Cuenta pagadora ${stamp}`;
  const switchingId = randomUUID();
  const switchingName = `Cuenta que cambia ${stamp}`;
  const debtId = randomUUID();
  const debtName = `Deuda del menú ${stamp}`;

  test.beforeEach(async () => {
    await seedAsset({ id: sourceId, name: sourceName, openingCents: 900_000_000 });
    // Opens at zero, which both kinds admit: it is the source that stops being
    // an asset half way through the last test.
    await seedAsset({ id: switchingId, name: switchingName, openingCents: 0 });
    await seedDebt({
      id: debtId,
      name: debtName,
      owedCents: MENU_DEBT_OWED_CENTS,
    });
  });

  test.afterEach(async () => {
    await dropAccounts([debtId, sourceId, switchingId]);
  });

  test("the plan dialog schedules the lines the row's meta then counts", async ({
    page,
  }) => {
    await page.goto("/es/planning/debts");

    const row = page.getByRole("row").filter({ hasText: debtName });
    await expect(row.getByText(positionText(0, 6), { exact: true })).toHaveCount(0);

    await rowMenu(page, debtName).click();
    await page
      .getByRole("menuitem", { name: debts.rowNewPlan, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The plan lands on the debt whose menu opened it, which the dialog states
    // rather than offering as a choice (RF-81).
    await expect(dialog.getByText(debtName, { exact: true })).toBeVisible();

    await dialog
      .getByRole("textbox", { name: installments.principalLabel })
      .fill("600000");
    await dialog
      .getByRole("textbox", { name: installments.installmentsLabel })
      .fill("6");
    await dialog
      .getByRole("button", { name: installments.planSave, exact: true })
      .click();

    await expect(
      page.getByText(installments.planSaved, { exact: true }),
    ).toBeVisible();
    await expect(row.getByText(positionText(0, 6), { exact: true })).toBeVisible();

    // The dated schedule is derived server-side and the lines total the
    // principal exactly — no cent is lost to the split (RF-81).
    const [scheduled] = await fixtureSql<{ lines: string; total: string }[]>`
      select count(*)::text as lines, coalesce(sum(l.amount_cents), 0)::text as total
      from installment_lines l
      join installment_plans p on p.id = l.plan_id
      where p.account_id = ${debtId}`;
    expect(scheduled.lines).toBe("6");
    expect(scheduled.total).toBe(String(60_000_000));
  });

  test("the payment dialog closes the oldest cuotas, names what it did not reach and drops the saldo", async ({
    page,
  }) => {
    await seedPlan({
      accountId: debtId,
      merchant: `Compra del menú ${stamp}`,
      lines: 3,
      amountCents: MENU_LINE_CENTS,
      startDate: todayInBogota(),
    });

    await page.goto("/es/planning/debts");

    const row = page.getByRole("row").filter({ hasText: debtName });
    expect(await digitsOf(row.getByRole("cell").nth(6))).toBe(
      pesos(MENU_DEBT_OWED_CENTS),
    );

    await rowMenu(page, debtName).click();
    await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(debtName, { exact: true })).toBeVisible();

    await dialog.getByLabel(installments.fromLabel).click();
    await page.getByRole("option", { name: sourceName, exact: true }).click();
    await dialog
      .getByRole("textbox", { name: installments.amountLabel })
      .fill("250000");
    await dialog
      .getByRole("button", { name: installments.paymentSave, exact: true })
      .click();

    // Two lines of $100.000 are covered in full and the third is not: both the
    // count and the leftover come off the allocation itself (RF-82).
    await expect(
      page.getByText(atCount(installments.paymentPaidLines, 2), { exact: true }),
    ).toBeVisible();
    const remainder = page.getByText(
      installments.paymentRemainder.split("{")[0].trim(),
    );
    await expect(remainder).toBeVisible();
    expect(await digitsOf(remainder)).toBe(
      pesos(MENU_PAID_CENTS - 2 * MENU_LINE_CENTS),
    );

    await expect(row.getByText(positionText(2, 3), { exact: true })).toBeVisible();
    // The saldo is derived from the movements, so the payment moves it by
    // exactly what it paid.
    expect(await digitsOf(row.getByRole("cell").nth(6))).toBe(
      pesos(MENU_DEBT_OWED_CENTS - MENU_PAID_CENTS),
    );
  });

  test("a payment on a card with no installment plan says it was saved and names no cuota", async ({
    page,
  }) => {
    // Kills: «El pago no completó ninguna cuota» on a card that has none.
    await page.goto("/es/planning/debts");

    await rowMenu(page, cardName).click();
    await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(installments.fromLabel).click();
    await page.getByRole("option", { name: sourceName, exact: true }).click();
    await dialog
      .getByRole("textbox", { name: installments.amountLabel })
      .fill("50000");
    await dialog
      .getByRole("button", { name: installments.paymentSave, exact: true })
      .click();

    await expect(
      page.getByText(installments.paymentSaved, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(atCount(installments.paymentPaidLines, 0), { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(installments.paymentRemainder.split("{")[0].trim()),
    ).toHaveCount(0);
  });

  test("the source picker offers no liability, and a source that stopped being one is refused", async ({
    page,
  }) => {
    const dialog = page.getByRole("dialog");
    const options = page.getByRole("option");

    // A debt is paid from an asset (RF-16): the picker holds exactly the assets
    // the caller can read, and not one of the liabilities the screen behind it
    // is listing. The other project seeds assets for this user too, so the count
    // is read on both sides of the render, and the poll opens it again when a
    // seed landed in between.
    async function assetsNow(): Promise<number> {
      const rows = await fixtureSql<{ id: string }[]>`
        select id from accounts
        where owner_user_id = ${scope.userId}
          and kind = 'asset' and archived_at is null`;
      return rows.length;
    }

    await expect
      .poll(
        async () => {
          const before = await assetsNow();
          await page.goto("/es/planning/debts");
          await pageToRow(page, debtName);
          await rowMenu(page, debtName).click();
          await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();
          await expect(dialog).toBeVisible();
          await dialog.getByLabel(installments.fromLabel).click();
          await expect(options.first()).toBeVisible();
          const shown = await options.count();
          const after = await assetsNow();
          return [before, after].includes(shown) ? "match" : `${shown} | ${before} ${after}`;
        },
        { timeout: 25_000 },
      )
      .toBe("match");
    for (const liability of [debtName, cardName, bareName]) {
      await expect(options.filter({ hasText: liability })).toHaveCount(0);
    }

    // The roster the dialog is holding goes stale: the account it named stops
    // being an asset between the render and the submit, which is the one path
    // that reaches the refusal's own message.
    await page.getByRole("option", { name: switchingName, exact: true }).click();
    await dialog
      .getByRole("textbox", { name: installments.amountLabel })
      .fill("10000");
    await fixtureSql`
      update accounts set kind = 'liability', subtype = 'card'
      where id = ${switchingId}`;
    await dialog
      .getByRole("button", { name: installments.paymentSave, exact: true })
      .click();

    await expect(
      page.getByText(installments.errors.notFromAsset, { exact: true }),
    ).toBeVisible();
    // The kinds guard lands before anything is written.
    expect(
      await fixtureSql`select id from transactions where to_account_id = ${debtId}`,
    ).toHaveLength(0);
  });
});

const PLAN_LINES = 24;
const PLAN_PAID_LINES = 9;
const DETAIL_LINE_CENTS = 10_000_000;
const DETAIL_OWED_CENTS = PLAN_LINES * DETAIL_LINE_CENTS;
const DETAIL_PAID_CENTS = PLAN_PAID_LINES * DETAIL_LINE_CENTS;
const AFTER_CUT_OFF_CENTS = 30_000_000;
const DETAIL_MINIMUM_CENTS = 5_000_000;
const DETAIL_CUT_OFF_DAY = 15;
const DETAIL_DUE_DAY = 5;

// What the issuer printed at each past cut-off, oldest first. Three figures that
// differ, so a column read below speaks about each row and not about one number
// repeated down it. They are the statement's own and not the ledger's: RF-129
// stores what was printed and derives its distance from the movements on read.
const DETAIL_STATEMENT_CENTS = [-240_000_000, -200_000_000, -150_000_000];

// Day `day` of the civil month `back` months before today, as a YYYY-MM-DD string.
// `addCivilMonths` is asked only for the month it lands in.
function dayOfMonthBack(back: number, day: number): string {
  const [year, month] = addCivilMonths(todayInBogota(), -back).split("-");
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

/**
 * The closes a person recorded (RF-129). Nothing in the app cuts a period any
 * more — the fabricator that invented one per day-of-month is gone — so a history
 * the screen can read has to be written here: one row per past cut-off, each
 * period opening the day after the one before it closed.
 */
async function seedStatements({
  accountId,
  openedOn,
  balances,
}: {
  accountId: string;
  openedOn: string;
  balances: number[];
}): Promise<void> {
  await asHarnessUser(async (tx) => {
    let periodStart = openedOn;

    for (const [at, balance] of balances.entries()) {
      const cutOff = dayOfMonthBack(balances.length - at, DETAIL_CUT_OFF_DAY);
      // The due day falls in the month after the cut-off, the only side of it
      // `account_statements_due_after_cut_off` allows.
      const dueDate = dayOfMonthBack(balances.length - at - 1, DETAIL_DUE_DAY);

      await tx`
        insert into account_statements (
          account_id, period_start, cut_off_date, payment_due_date,
          closing_balance_cents, minimum_payment_cents)
        values (
          ${accountId}, ${periodStart}, ${cutOff}, ${dueDate},
          ${balance}, ${DETAIL_MINIMUM_CENTS})`;

      periodStart = addCivilDays(cutOff, 1);
    }
  });
}

// What the account's own movements say it stood at, up to and including a
// cut-off — independent of `account-statements.ts:71`, which is the figure a
// test naming the same source it asserts against could never catch drifting.
// Every movement this fixture writes settles in the account's own settlement
// currency, so the walk is the plain sum a statement's gap is measured against.
async function derivedBalanceCents(
  accountId: string,
  cutOffDate: string,
): Promise<number> {
  const [row] = await fixtureSql<{ derived: string }[]>`
    select (
      a.initial_balance_cents
        + coalesce((
            select sum(t.amount_cents) from transactions t
            where t.to_account_id = a.id and t.occurred_at <= ${cutOffDate}::date
          ), 0)
        - coalesce((
            select sum(t.amount_cents) from transactions t
            where t.from_account_id = a.id and t.occurred_at <= ${cutOffDate}::date
          ), 0)
    )::text as derived
    from accounts a
    where a.id = ${accountId}`;

  return Number(row.derived);
}

test.describe("the detail route", () => {
  const detailId = randomUUID();
  const detailName = `Deuda con extractos ${stamp}`;
  const payerId = randomUUID();
  const payerName = `Cuenta del extracto ${stamp}`;
  const planTitle = `Compra a cuotas ${stamp}`;

  let paymentId = "";

  // Opened four months back so past cut-offs exist to close, and settled by one
  // movement dated between two of them, so the frozen balances differ from
  // period to period rather than repeating one figure.
  test.beforeEach(async () => {
    const openedOn = addCivilMonths(todayInBogota(), -4);

    // The payer opens with the debt, so the payment 70 days back postdates it (RF-162).
    await seedAsset({ id: payerId, name: payerName, openingCents: 900_000_000, openedOn });
    await seedDebt({
      id: detailId,
      name: detailName,
      owedCents: DETAIL_OWED_CENTS,
      openedOn,
      terms: {
        debtKind: "revolving",
        annualRate: ANNUAL_RATE,
        minimumPaymentCents: DETAIL_MINIMUM_CENTS,
        creditLimitCents: 400_000_000,
        cutOffDay: DETAIL_CUT_OFF_DAY,
        dueDay: DETAIL_DUE_DAY,
      },
    });
    await seedStatements({
      accountId: detailId,
      openedOn,
      balances: DETAIL_STATEMENT_CENTS,
    });
    paymentId = await seedPayment({
      fromId: payerId,
      toId: detailId,
      amountCents: DETAIL_PAID_CENTS,
      occurredAt: addCivilDays(todayInBogota(), -70),
    });
    await seedPlan({
      accountId: detailId,
      merchant: planTitle,
      lines: PLAN_LINES,
      amountCents: DETAIL_LINE_CENTS,
      startDate: openedOn,
      paidLines: PLAN_PAID_LINES,
      paidTransactionId: paymentId,
    });
  });

  test.afterEach(async () => {
    await dropAccounts([detailId, payerId]);
  });

  test("marks the nine lines a movement settled and totals the pending of the other fifteen", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${detailId}`);

    const plan = page.getByRole("table", { name: planTitle });
    // The column headers and the totals ride rows of their own; the read below
    // is a snapshot and does not wait for the render behind it.
    await expect(plan.getByRole("row")).toHaveCount(PLAN_LINES + 2);
    await expect(
      plan.getByText(
        installments.planPosition
          .replace("{paid}", String(PLAN_PAID_LINES))
          .replace("{total}", String(PLAN_LINES)),
        { exact: true },
      ),
    ).toBeVisible();

    // A line reads paid exactly when a movement is linked to it, and that
    // movement is reachable from the row (RF-82).
    const status = await readColumn(plan, 3, 5);
    expect(status).toHaveLength(PLAN_LINES);
    expect(status.filter((cell) => cell === installments.statusPaid)).toHaveLength(
      PLAN_PAID_LINES,
    );
    expect(
      status.filter((cell) => cell === installments.statusPending),
    ).toHaveLength(PLAN_LINES - PLAN_PAID_LINES);
    await expect(
      plan.getByRole("link", { name: installments.viewMovement, exact: true }),
    ).toHaveCount(PLAN_PAID_LINES);

    // The pending is the sum of the lines still unpaid, and of no others.
    const amounts = await readColumn(plan, 2, 5);
    const pending = amounts
      .filter((_, at) => status[at] === installments.statusPending)
      .reduce((sum, cell) => sum + digitsIn(cell), 0);
    expect(pending).toBe(
      pesos((PLAN_LINES - PLAN_PAID_LINES) * DETAIL_LINE_CENTS),
    );

    // The totals row of the plan and the screen's own tile both state it.
    const totals = await readColumn(plan, 2, 3);
    expect(digitsIn(totals[0])).toBe(pending);
    expect(
      await digitsOf(
        tileValue(page.getByRole("main"), installments.tilePending),
      ),
    ).toBe(pending);
  });

  test("reads the frozen statement saldos, which a later movement leaves alone while the open period moves", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${detailId}`);

    const history = page.getByRole("table", {
      name: installments.statementsTitle,
    });
    await expect(history).toBeVisible();

    // The screen reads back the closes that were recorded, and exactly the
    // balances they printed (RF-129). It generates none of them itself.
    const stored = await fixtureSql<{ balance: string }[]>`
      select closing_balance_cents::text as balance
      from account_statements where account_id = ${detailId}
      order by cut_off_date desc`;
    expect(stored.length).toBe(DETAIL_STATEMENT_CENTS.length);

    // The column headers ride a row of their own, so the history is drawn once
    // the table carries one row more than it has periods. Read only then: a
    // column read is a snapshot and does not wait for the render behind it.
    await expect(history.getByRole("row")).toHaveCount(stored.length + 1);

    const shown = await readColumn(history, 3, 8);
    expect(shown.map(digitsIn)).toEqual(
      stored.map((row) => pesos(Math.abs(Number(row.balance)))),
    );
    // They differ, so "unchanged" below is a statement about each row and not
    // about one figure repeated down the column.
    expect(new Set(shown).size).toBe(DETAIL_STATEMENT_CENTS.length);

    const openBefore = await digitsOf(openPeriodBalance(page));

    // A movement after the last cut-off falls in the period nobody has closed.
    await seedPayment({
      fromId: payerId,
      toId: detailId,
      amountCents: AFTER_CUT_OFF_CENTS,
      occurredAt: todayInBogota(),
    });
    await page.reload();
    await expect(history.getByRole("row")).toHaveCount(stored.length + 1);

    expect((await readColumn(history, 3, 8)).map(digitsIn)).toEqual(
      shown.map(digitsIn),
    );
    expect(await digitsOf(openPeriodBalance(page))).toBe(
      openBefore - pesos(AFTER_CUT_OFF_CENTS),
    );

    // And a snapshot is immutable: nothing rewrote the rows either (RF-129).
    const after = await fixtureSql<{ balance: string }[]>`
      select closing_balance_cents::text as balance
      from account_statements where account_id = ${detailId}
      order by cut_off_date desc`;
    expect(after).toEqual(stored);
  });

  test("records what a person types into the dialog, and shows the row with the gap the base derives", async ({
    page,
  }) => {
    // After the last seeded cut-off and short of it — a period the earlier
    // closes leave open (RF-129).
    const periodStart = addCivilDays(dayOfMonthBack(1, DETAIL_CUT_OFF_DAY), 1);
    const cutOffDate = todayInBogota();
    const closingMajor = "2150000";

    await page.goto(`/es/planning/debts/${detailId}`);

    await page
      .getByRole("button", { name: installments.statementRecord, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // A date input carries no textbox role, so it is reached by its label.
    await dialog
      .getByLabel(installments.statementPeriodStartLabel)
      .fill(periodStart);
    await dialog.getByLabel(installments.statementCutOffLabel).fill(cutOffDate);
    await dialog
      .getByRole("textbox", { name: installments.statementClosingLabel })
      .fill(closingMajor);
    await dialog
      .getByRole("button", { name: installments.statementRecordSave, exact: true })
      .click();

    await expect(
      page.getByText(installments.statementRecorded, { exact: true }),
    ).toBeVisible();

    const history = page.getByRole("table", {
      name: installments.statementsTitle,
    });
    await expect(history.getByRole("row")).toHaveCount(
      DETAIL_STATEMENT_CENTS.length + 2,
    );

    const [stored] = await fixtureSql<{ closing: string }[]>`
      select closing_balance_cents::text as closing
      from account_statements
      where account_id = ${detailId} and cut_off_date = ${cutOffDate}::date`;
    const closingCents = Number(stored.closing);
    // The magnitude a person typed lands negative on a liability (RF-129): the
    // sign is resolved in SQL from the account's own kind, never carried in
    // the payload the dialog sent.
    expect(closingCents).toBe(-Number(closingMajor) * 100);

    // The gap this test compares against is measured straight off the
    // movements, not by calling the query the screen itself reads (RF-129).
    const derived = await derivedBalanceCents(detailId, cutOffDate);
    const gapCents = closingCents - derived;

    // Cut off most recently, so the row this test wrote sorts first.
    const gapShown = (await readColumn(history, 7, 8))[0];
    expect(digitsIn(gapShown)).toBe(pesos(Math.abs(gapCents)));
    expect(gapShown.includes(MINUS)).toBe(gapCents < 0);
  });

  test("leaves interest and fees blank, and the recorded row shows empty cells rather than a zero", async ({
    page,
  }) => {
    const periodStart = addCivilDays(dayOfMonthBack(1, DETAIL_CUT_OFF_DAY), 1);
    const cutOffDate = todayInBogota();
    const closingMajor = "1800000";

    await page.goto(`/es/planning/debts/${detailId}`);

    await page
      .getByRole("button", { name: installments.statementRecord, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog
      .getByLabel(installments.statementPeriodStartLabel)
      .fill(periodStart);
    await dialog.getByLabel(installments.statementCutOffLabel).fill(cutOffDate);
    await dialog
      .getByRole("textbox", { name: installments.statementClosingLabel })
      .fill(closingMajor);
    // Interest and fees stay untouched: a blank field is what "the statement
    // never printed it" means, and typing a zero would claim the issuer
    // charged nothing (RF-130).
    await dialog
      .getByRole("button", { name: installments.statementRecordSave, exact: true })
      .click();

    await expect(
      page.getByText(installments.statementRecorded, { exact: true }),
    ).toBeVisible();

    const history = page.getByRole("table", {
      name: installments.statementsTitle,
    });
    await expect(history.getByRole("row")).toHaveCount(
      DETAIL_STATEMENT_CENTS.length + 2,
    );

    // Both cells are drawn empty, not the digit "0" a blank charge would read
    // as if the column ever fell back to zero.
    expect((await readColumn(history, 5, 8))[0]).toBe("");
    expect((await readColumn(history, 6, 8))[0]).toBe("");

    const [stored] = await fixtureSql<
      { interest: number | null; fees: number | null }[]
    >`
      select interest_charged_cents as interest, fees_charged_cents as fees
      from account_statements
      where account_id = ${detailId} and cut_off_date = ${cutOffDate}::date`;
    expect(stored.interest).toBeNull();
    expect(stored.fees).toBeNull();
  });

  test("names every line the delete drops, and keeps the movement it unlinks", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${detailId}`);

    await rowMenu(page, planTitle).click();
    await page.getByRole("menuitem", { name: common.delete, exact: true }).click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(
        installments.deleteDescription.replace("{count}", String(PLAN_LINES)),
        { exact: true },
      ),
    ).toBeVisible();

    await confirm
      .getByRole("button", { name: common.delete, exact: true })
      .click();
    await expect(
      page.getByText(installments.planDeleted, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(installments.plansEmpty, { exact: true }),
    ).toBeVisible();

    // The lines go with the plan; the movement that paid nine of them stays,
    // unlinked, which is what the confirmation said it would do.
    expect(
      await fixtureSql`select id from installment_plans where account_id = ${detailId}`,
    ).toHaveLength(0);
    expect(
      await fixtureSql`select id from transactions where id = ${paymentId}`,
    ).toHaveLength(1);
  });
});

const PHONE_LINES = 4;
const PHONE_PAID_LINES = 1;
const PHONE_LINE_CENTS = 15_000_000;
const PHONE_OPENING_CENTS = PHONE_LINES * PHONE_LINE_CENTS;
const PHONE_OWED_CENTS =
  PHONE_OPENING_CENTS - PHONE_PAID_LINES * PHONE_LINE_CENTS;

test.describe("the phone list", () => {
  // RNF-08's base case, driven at the artboard's own width by both projects.
  test.use({ viewport: { width: 360, height: 740 } });

  const phoneId = randomUUID();
  const phoneName = `Deuda a cuotas ${stamp}`;
  const phonePayerId = randomUUID();
  const phonePayerName = `Cuenta del teléfono ${stamp}`;

  test.beforeAll(async () => {
    await seedAsset({
      id: phonePayerId,
      name: phonePayerName,
      openingCents: 900_000_000,
    });
    await seedDebt({
      id: phoneId,
      name: phoneName,
      owedCents: PHONE_OPENING_CENTS,
      // A debt read by its kind: the card the phone draws for it is the one that
      // states a plan position (RF-81).
      terms: { debtKind: "installment", annualRate: 0.2 },
    });
    const paid = await seedPayment({
      fromId: phonePayerId,
      toId: phoneId,
      amountCents: PHONE_PAID_LINES * PHONE_LINE_CENTS,
      occurredAt: todayInBogota(),
    });
    await seedPlan({
      accountId: phoneId,
      merchant: `Compra del teléfono ${stamp}`,
      lines: PHONE_LINES,
      amountCents: PHONE_LINE_CENTS,
      startDate: todayInBogota(),
      paidLines: PHONE_PAID_LINES,
      paidTransactionId: paid,
    });
  });

  test.afterAll(async () => {
    await dropAccounts([phoneId, phonePayerId]);
  });

  test("shows the card list without the laptop table, and the installment card states its plan position", async ({
    page,
  }) => {
    await page.goto("/es/planning/debts");

    // The dense table renders from `lg` up and is not in the tree below it, so
    // the phone is not carrying a second copy of every figure.
    await expect(page.getByRole("table", { name: debts.title })).toHaveCount(0);
    await expect(band(page)).toHaveCount(1);

    await expect(band(page).getByText(phoneName, { exact: true })).toBeVisible();
    // Read inside this debt's own card: the other project seeds a twin plan with
    // the same position under this user.
    await expect(
      phoneCard(page, phoneName, phoneId).getByText(
        positionText(PHONE_PAID_LINES, PHONE_LINES),
        { exact: true },
      ),
    ).toBeVisible();
    expect(await digitsOf(cardOwed(page, phoneName))).toBe(
      pesos(PHONE_OWED_CENTS),
    );
  });

  test("the card's detail control opens that debt and not the list", async ({
    page,
  }) => {
    await page.goto("/es/planning/debts");

    // The phone has no row menu, so this control is the only way into a debt's
    // cuotas and its extractos from here.
    await cardDetailLink(page, phoneId).click();

    await expect(page).toHaveURL(`/es/planning/debts/${phoneId}`);
    await expect(
      page.getByRole("heading", { name: phoneName, exact: true }),
    ).toBeVisible();
  });
});

const READER_OWED_CENTS = 80_000_000;
const READER_LIMIT_CENTS = 250_000_000;

test.describe("under a plain member", () => {
  // The second identity, who belongs to the fund and owns none of its accounts:
  // the policies show them every debt below and admit no write to any of it,
  // which is the flag all three surfaces gate on (RF-58, RF-100).
  test.use({ storageState: MEMBER_STORAGE_STATE });

  const readerId = randomUUID();
  const readerName = `Deuda compartida ${stamp}`;
  const readerPlanTitle = `Compra compartida ${stamp}`;

  // `seedGroup` clears every fund the two identities belong to before it builds
  // its own, so the other project seeding here at the same time would tear this
  // fund down mid-test. A session lock keyed on the user makes it wait for this
  // describe's `clearGroup`, on a connection of its own: the fixtures' single
  // one keeps serving the seeds while the lock is held.
  let fundLock: postgres.Sql | null = null;
  const fundLockKey = `debts.spec fund ${scope.userId}`;

  test.beforeAll(async () => {
    fundLock = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    await fundLock`select pg_advisory_lock(hashtext(${fundLockKey}))`;

    await seedGroup();
    await seedDebt({
      id: readerId,
      name: readerName,
      owedCents: READER_OWED_CENTS,
      terms: {
        debtKind: "revolving",
        annualRate: 0.18,
        minimumPaymentCents: 2_000_000,
        creditLimitCents: READER_LIMIT_CENTS,
      },
    });
    await seedPlan({
      accountId: readerId,
      merchant: readerPlanTitle,
      lines: 3,
      amountCents: 5_000_000,
      startDate: todayInBogota(),
    });
  });

  test.afterAll(async () => {
    await dropAccounts([readerId]);
    await clearGroup();
    if (fundLock !== null) {
      await fundLock`select pg_advisory_unlock(hashtext(${fundLockKey}))`;
      await fundLock.end();
      fundLock = null;
    }
  });

  test("reads every figure on the list and is offered no write over it", async ({
    page,
  }, testInfo) => {
    // Both shapes stay mounted at every width and CSS displays one of them, so
    // each viewport is read through the surface it actually renders.
    const desktop = testInfo.project.name === "desktop";

    await page.goto("/es/planning/debts");

    if (desktop) {
      await pageToRow(page, readerName);
      await rowMenu(page, readerName).click();
      // Reading a debt is offered to everyone it is shown to; writing one only
      // to the caller the policies would admit.
      await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
        debts.rowDetail,
      ]);
      await page.keyboard.press("Escape");

      const row = page.getByRole("row").filter({ hasText: readerName });
      expect(await digitsOf(row.getByRole("cell").nth(6))).toBe(
        pesos(READER_OWED_CENTS),
      );
      expect(await digitsOf(row.getByRole("cell").nth(1))).toBe(
        pesos(READER_LIMIT_CENTS - READER_OWED_CENTS),
      );
    } else {
      // The phone card's only controls are the abono and the invitation to
      // complete a bare debt's terms; a reader is handed neither, on this card
      // or on any other the fund is showing them.
      await expect(
        band(page).getByRole("button", { name: debts.rowPay, exact: true }),
      ).toHaveCount(0);
      await expect(
        band(page).getByRole("button", { name: debts.completeTerms, exact: true }),
      ).toHaveCount(0);
      // Reading is never closed: the door onto this debt's own detail is on the
      // card whether or not the caller may write it.
      await expect(cardDetailLink(page, readerId)).toBeVisible();
      expect(await digitsOf(cardOwed(page, readerName))).toBe(
        pesos(READER_OWED_CENTS),
      );
    }
  });

  test("reads the detail and is offered neither the abono, the plan nor the delete", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${readerId}`);

    await expect(
      page.getByRole("heading", { name: readerName, exact: true }),
    ).toBeVisible();

    // Every figure still reads. The saldo names the tile, the open period and
    // the statements column alike, so the first of them is the tile.
    const main = page.getByRole("main");
    expect(await digitsOf(tileValue(main, debts.tableBalance).first())).toBe(
      pesos(READER_OWED_CENTS),
    );
    expect(await digitsOf(tileValue(main, debts.tileAvailableCredit))).toBe(
      pesos(READER_LIMIT_CENTS - READER_OWED_CENTS),
    );
    await expect(page.getByRole("table", { name: readerPlanTitle })).toBeVisible();

    // And no action the database would refuse is on offer.
    await expect(
      page.getByRole("button", { name: debts.rowPay, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: debts.rowNewPlan, exact: true }),
    ).toHaveCount(0);
    await expect(rowMenu(page, readerPlanTitle)).toHaveCount(0);
  });
});

const FOREIGN_DEBT_OWED_CENTS = 20_000_000;
// $80.00, stored in dollars' own scale — hundredths of the major unit, the
// same as every currency (RNF-05).
const FOREIGN_USD_CENTS = 8_000;
const FOREIGN_COP_ESTIMATE_CENTS = 3_200_000;
const FOREIGN_COP_BILLED_CENTS = 3_180_000;

test.describe("a debt with a foreign purchase", () => {
  const foreignDebtId = randomUUID();
  const foreignDebtName = `Tarjeta con compra foránea ${stamp}`;
  const foreignCategoryId = randomUUID();
  const purchaseDescription = `Compra en dólares ${stamp}`;

  test.beforeEach(async () => {
    await seedDebt({
      id: foreignDebtId,
      name: foreignDebtName,
      owedCents: FOREIGN_DEBT_OWED_CENTS,
      terms: { debtKind: "revolving", annualRate: 0.2 },
    });

    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${foreignCategoryId}, ${scope.userId}, ${`Compra foránea ${stamp}`}, 'expense', '#4C8C4A')`;

      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (
          from_account_id, amount_cents, occurred_at, description,
          currency, counter_amount_cents, counter_is_estimate)
        values (
          ${foreignDebtId}, ${FOREIGN_USD_CENTS}, ${todayInBogota()},
          ${purchaseDescription}, 'USD', ${FOREIGN_COP_ESTIMATE_CENTS}, true)
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${foreignCategoryId}, ${FOREIGN_USD_CENTS})`;
    });
  });

  test.afterEach(async () => {
    await dropAccounts([foreignDebtId]);
    await fixtureSql`delete from categories where id = ${foreignCategoryId}`;
  });

  test("lists the still-estimated purchase, and billing it clears the mark and moves the balance to pesos", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${foreignDebtId}`);

    await expect(page.getByText(settlement.title, { exact: true })).toBeVisible();
    await expect(page.getByText(purchaseDescription, { exact: true })).toBeVisible();

    // What was spent, in dollars — never the peso estimate standing in for it.
    const spentRow = page.getByText(settlement.spent, { exact: true }).locator("..");
    // Dollars are written with two decimals, the same as the stored scale
    // (RNF-05), so the digits shown are the stored cents directly.
    expect(await digitsOf(spentRow)).toBe(FOREIGN_USD_CENTS);

    const estimateRow = page
      .getByText(settlement.estimate, { exact: true })
      .locator("..");
    await expect(estimateRow).toContainText("≈");
    expect(await digitsOf(estimateRow)).toBe(pesos(FOREIGN_COP_ESTIMATE_CENTS));

    // Before a statement replaces it, the estimate sits in its own foreign
    // pocket and the settlement one holds only what the account opened owing
    // (RF-121, RF-123) — read against `account_balances`, never asserted from
    // the screen alone.
    const beforeBill = await fixtureSql<{ currency: string; balance_cents: string }[]>`
      select currency, balance_cents::text as balance_cents
      from account_balances where id = ${foreignDebtId} order by currency`;
    expect(beforeBill).toEqual([
      { currency: "COP", balance_cents: String(-FOREIGN_DEBT_OWED_CENTS) },
      { currency: "USD", balance_cents: String(-FOREIGN_USD_CENTS) },
    ]);

    await page
      .getByLabel(settlement.billedLabel)
      .fill(String(pesos(FOREIGN_COP_BILLED_CENTS)));
    await page.getByRole("button", { name: settlement.save, exact: true }).click();

    await expect(page.getByText(settlement.saved, { exact: true })).toBeVisible();
    // The mark is what moves the row, not a second list kept alongside it.
    await expect(page.getByText(purchaseDescription, { exact: true })).toHaveCount(0);
    await expect(page.getByText(settlement.empty, { exact: true })).toBeVisible();

    // Billed, the dollar pocket nets to zero and drops out (it carries no
    // opening balance of its own to keep it), and the peso one carries what
    // the issuer billed, never the estimate (RF-123, RF-124).
    const afterBill = await fixtureSql<{ currency: string; balance_cents: string }[]>`
      select currency, balance_cents::text as balance_cents
      from account_balances where id = ${foreignDebtId} order by currency`;
    expect(afterBill).toEqual([
      {
        currency: "COP",
        balance_cents: String(-(FOREIGN_DEBT_OWED_CENTS + FOREIGN_COP_BILLED_CENTS)),
      },
    ]);
  });
});

test("stores card for a debt made in the debt form", async ({ page }) => {
  const name = `Deuda formulario ${stamp}`;

  await page.goto("/es/planning/debts");
  await page.getByRole("button", { name: debts.add, exact: true }).filter({ visible: true }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: debts.nameLabel }).fill(name);
  await dialog.getByRole("textbox", { name: debts.openingBalanceLabel }).fill("100000");
  await dialog.getByRole("textbox", { name: debts.annualRateLabel }).fill("24");
  await dialog.getByRole("button", { name: debts.save, exact: true }).click();
  await expect(dialog).toBeHidden();

  const rows = await fixtureSql<{ id: string; kind: string; subtype: string }[]>`
    select id, kind, subtype from accounts
    where owner_user_id = ${scope.userId} and name = ${name}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("liability");
  expect(rows[0].subtype).toBe("card");

  await dropAccounts([rows[0].id]);
});

// A debt whose terms fail is never created twice (RF-78, RF-79). The dialog
// creates the account, then writes its terms; when the second step fails the
// account already exists, so the dialog must keep its id and retry the terms
// alone. The two server actions are told apart by what they carry: the terms
// payload names `debtKind`, the account payload does not.
test.describe("a debt whose terms fail to save", () => {
  // A failed run leaves its bare account behind; drop whatever this stamp made.
  test.afterEach(async () => {
    const left = await fixtureSql<{ id: string }[]>`
      select id from accounts
      where owner_user_id = ${scope.userId} and name like ${`Deuda % ${stamp}%`}`;
    if (left.length > 0) await dropAccounts(left.map((row) => row.id));
  });

  const isTermsCall = (body: string | null): boolean =>
    body !== null && body.includes('"debtKind"');
  const isCreateCall = (body: string | null): boolean =>
    body !== null && body.includes('"kind":"liability"') && !isTermsCall(body);

  async function rowsNamed(name: string) {
    return fixtureSql<{ id: string; annual_rate: string | null }[]>`
      select a.id, t.annual_rate::text as annual_rate
      from accounts a
      left join debt_terms t on t.account_id = a.id
      where a.owner_user_id = ${scope.userId} and a.name = ${name}`;
  }

  async function fillAndSave(page: Page, name: string): Promise<Locator> {
    await page.goto("/es/planning/debts");
    await page
      .getByRole("button", { name: debts.add, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: debts.nameLabel }).fill(name);
    await dialog.getByRole("textbox", { name: debts.openingBalanceLabel }).fill("100000");
    await dialog.getByRole("textbox", { name: debts.annualRateLabel }).fill("24");
    return dialog;
  }

  // Two ways the terms step can fail: the request dies (a thrown error), or the
  // server answers with a refusal (it rejects the payload).
  const failures = [
    {
      label: "the request dies",
      fail: async (route: import("@playwright/test").Route) => route.abort("failed"),
    },
    {
      label: "the server refuses",
      fail: async (route: import("@playwright/test").Route) => {
        const body = route.request().postData() ?? "";
        await route.continue({
          postData: body.replace('"debtKind":"revolving"', '"debtKind":"bogus"'),
        });
      },
    },
  ];

  for (const { label, fail } of failures) {
    test(`${label}: the dialog says so, and a retry saves the terms on the one account`, async ({
      page,
    }) => {
      const name = `Deuda reintento ${stamp} ${randomUUID().slice(0, 4)}`;
      let creates = 0;
      let termsAttempts = 0;
      let holding = false;
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let failing = true;

      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.method() === "POST" ? request.postData() : null;
        if (!request.headers()["next-action"]) return route.fallback();
        if (isCreateCall(body)) creates += 1;
        if (!isTermsCall(body)) return route.fallback();
        termsAttempts += 1;
        if (failing) return fail(route);
        if (holding) await gate;
        return route.fallback();
      });

      const dialog = await fillAndSave(page, name);
      await dialog.getByRole("button", { name: debts.save, exact: true }).click();

      // Refused: the account exists, so the dialog is now about its terms.
      await expect.poll(() => termsAttempts).toBe(1);
      await expect(page.getByText(debts.errors.termsNotSaved)).toBeVisible();
      await expect(
        page.getByRole("dialog", { name: debts.completeTermsTitle }),
      ).toBeVisible();
      expect((await rowsNamed(name)).length).toBe(1);
      expect(creates).toBe(1);

      // Retried with the route released, held open to see the pending state.
      failing = false;
      holding = true;
      const submit = page
        .getByRole("dialog")
        .getByRole("button", { name: debts.save, exact: true });
      await submit.click();
      await expect(submit).toBeDisabled();
      openGate();
      await expect(page.getByRole("dialog")).toBeHidden();

      expect(creates).toBe(1);
      expect(termsAttempts).toBe(2);
      const rows = await rowsNamed(name);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].annual_rate)).toBeCloseTo(ANNUAL_RATE, 6);

      await dropAccounts(rows.map((row) => row.id));
    });
  }

  test("cancelling after the refusal leaves the account, listed without terms", async ({
    page,
  }) => {
    const name = `Deuda cancelada ${stamp} ${randomUUID().slice(0, 4)}`;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.headers()["next-action"] &&
        isTermsCall(request.postData())
      ) {
        return route.abort("failed");
      }
      return route.fallback();
    });

    const dialog = await fillAndSave(page, name);
    await dialog.getByRole("button", { name: debts.save, exact: true }).click();
    await expect(page.getByText(debts.errors.termsNotSaved)).toBeVisible();

    await page
      .getByRole("dialog")
      .getByRole("button", { name: common.cancel, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();

    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0].annual_rate).toBeNull();

    await page.unroute("**/*");
    await page.reload();
    await expect(
      page.getByText(name, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();

    await dropAccounts(rows.map((row) => row.id));
  });

  test("the ordinary path creates the account and its terms and closes", async ({
    page,
  }) => {
    const name = `Deuda ordinaria ${stamp} ${randomUUID().slice(0, 4)}`;
    const dialog = await fillAndSave(page, name);
    await dialog.getByRole("button", { name: debts.save, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(debts.errors.termsNotSaved)).toHaveCount(0);

    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].annual_rate)).toBeCloseTo(ANNUAL_RATE, 6);

    await dropAccounts(rows.map((row) => row.id));
  });
});

// A payment whose answer never reached the browser (RNF-10, Q24): the server
// booked it, the browser saw the request fail, and the person presses save again.
// One opening of the dialog is one payment, however many times it is sent.
test.describe("a debt payment sent again", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const sourceId = randomUUID();
  const sourceName = `Cuenta de reenvío ${stamp}`;
  const debtId = randomUUID();
  const debtName = `Deuda de reenvío ${stamp}`;

  test.beforeEach(async () => {
    await seedAsset({ id: sourceId, name: sourceName, openingCents: 900_000_000 });
    await seedDebt({ id: debtId, name: debtName, owedCents: 80_000_000 });
  });

  test.afterEach(async () => {
    await dropAccounts([debtId, sourceId]);
  });

  async function booked(): Promise<{ amount_cents: string }[]> {
    return fixtureSql<{ amount_cents: string }[]>`
      select amount_cents::text as amount_cents from transactions
      where to_account_id = ${debtId} order by created_at`;
  }

  async function openPayment(page: Page): Promise<Locator> {
    await rowMenu(page, debtName).click();
    await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(installments.fromLabel).click();
    await page.getByRole("option", { name: sourceName, exact: true }).click();
    return dialog;
  }

  const save = (dialog: Locator) =>
    dialog.getByRole("button", { name: installments.paymentSave, exact: true });

  test("a save whose answer was lost, saved again, books exactly one payment", async ({ page }) => {
    // Kills: a new request ref minted on every click, or none sent, so the resend books a second payment.
    let dropped = 0;
    await page.route(
      (url) => url.pathname.startsWith("/es"),
      async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] && dropped === 0) {
          dropped += 1;
          await route.fetch();
          await route.abort("failed");
          return;
        }
        await route.continue();
      },
    );

    await page.goto("/es/planning/debts");
    const dialog = await openPayment(page);
    await dialog.getByRole("textbox", { name: installments.amountLabel }).fill("120000");

    await save(dialog).click();
    await expect.poll(() => dropped).toBe(1);
    // The server booked it; the person never heard.
    await expect.poll(async () => (await booked()).length).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(save(dialog)).toBeEnabled();

    await save(dialog).click();
    await expect(dialog).toBeHidden();

    const rows = await booked();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe("12000000");
  });

  test("two separate openings, saved once each, book two payments", async ({ page }) => {
    // Kills: a request ref that outlives its opening, so the second payment answers the first.
    // The page is not reloaded between them: a ref held by the module would survive.
    await page.goto("/es/planning/debts");
    for (const amount of ["120000", "130000"]) {
      const dialog = await openPayment(page);
      await dialog.getByRole("textbox", { name: installments.amountLabel }).fill(amount);
      await save(dialog).click();
      await expect(dialog).toBeHidden();
    }

    const rows = await booked();
    expect(rows.map((row) => row.amount_cents).sort()).toEqual(["12000000", "13000000"]);
  });
});

// ---------------------------------------------------------------------------
// A card in credit, at zero, and a pocket in another currency (RF-80, RF-83,
// RF-124, RF-125; `docs/DESIGN.md` § Debts, boards DeudasAFavorMovil,
// DeudasEnCeroMovil, DeudasBolsilloAFavorMovil).
// ---------------------------------------------------------------------------

const STATE_LIMIT_CENTS = 100_000_000;
const STATE_CREDIT_CENTS = 15_000_000;
const STATE_BARE_CREDIT_CENTS = 3_000_000;
const STATE_OWING_CENTS = 20_000_000;
const STATE_MINIMUM_CENTS = 1_000_000;
const STATE_RATE = 0.24;
const STATE_OWING_INTEREST_CENTS = Math.round(
  STATE_OWING_CENTS * ((1 + STATE_RATE) ** (1 / 12) - 1),
);

// What a row reads once the spaces ICU chooses (no-break included) are one.
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Whole pesos with the Colombian dot, written here so the browser's ICU is not
// what the expectation is read from.
function groupedPesos(cents: number): string {
  return String(cents / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// The ink of the first leaf under a figure's container, which is the element
// `Money` or `Figure` paints; computed, so a tone read off the token is a tone.
async function inkOf(container: Locator): Promise<string> {
  return container.evaluate((node) => {
    let leaf: Element = node;
    while (leaf.firstElementChild) leaf = leaf.firstElementChild;
    return getComputedStyle(leaf).color;
  });
}

async function accentInk(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent-11)";
    document.querySelector("main")!.appendChild(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return ink;
  });
}

// The deepest elements under `scope` whose whole text is exactly `whole`, each
// with the ink it computes to. A figure drawn as bare text beside a span holds
// its words in the wrapper and only the amount in the span, so the deepest
// holder of the whole text is the wrapper and its ink is not the span's.
async function holdersOf(
  scope: Locator,
  whole: string,
): Promise<{ text: string; ink: string }[]> {
  return scope.evaluate((root, wanted) => {
    const flatten = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
    const hits = [root, ...Array.from(root.querySelectorAll("*"))].filter(
      (node) => flatten(node) === wanted,
    );
    return hits
      .filter((node) => !hits.some((other) => other !== node && node.contains(other)))
      .map((node) => ({ text: flatten(node), ink: getComputedStyle(node).color }));
  }, whole);
}

// The ink of the element that directly holds the text matching `pattern`.
async function inkOfText(scope: Locator, pattern: RegExp): Promise<string[]> {
  return scope.evaluate(
    (root, source) => {
      const matcher = new RegExp(source);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const inks: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (matcher.test(node.textContent ?? "") && node.parentElement) {
          inks.push(getComputedStyle(node.parentElement).color);
        }
      }
      return inks;
    },
    pattern.source,
  );
}

// The figure column of one debt, at whichever width is displayed: on the phone
// the head's right-hand column, on the laptop the balance cell.
function figureOf(page: Page, name: string, cells: Locator | null): Locator {
  return cells ?? cardOwed(page, name);
}

for (const [bandLabel, width] of [
  ["phone", 360],
  ["laptop", 1280],
] as const) {
  const laptop = width >= 1024;

  test.describe(`${bandLabel}: a card in credit, at zero and owing`, () => {
    test.use({ viewport: { width, height: 900 } });

    const creditId = randomUUID();
    const creditName = `Tarjeta a favor ${bandLabel} ${stamp}`;
    const payerId = randomUUID();
    const payerName = `Cuenta pagadora ${bandLabel} ${stamp}`;
    const zeroId = randomUUID();
    const zeroName = `Tarjeta en cero ${bandLabel} ${stamp}`;
    const owingId = randomUUID();
    const owingName = `Tarjeta con saldo ${bandLabel} ${stamp}`;
    const bareCreditId = randomUUID();
    const bareCreditName = `Tarjeta sin términos a favor ${bandLabel} ${stamp}`;

    const terms: SeededTerms = {
      debtKind: "revolving",
      annualRate: STATE_RATE,
      minimumPaymentCents: STATE_MINIMUM_CENTS,
      creditLimitCents: STATE_LIMIT_CENTS,
      cutOffDay: 15,
      dueDay: 5,
    };

    test.beforeAll(async () => {
      // A liability cannot open positive, so the credit is an overpayment: it
      // opens at zero and a transfer from an asset lands on it.
      await seedAsset({ id: payerId, name: payerName, openingCents: 900_000_000 });
      await seedDebt({ id: creditId, name: creditName, owedCents: 0, terms });
      await seedPayment({
        fromId: payerId,
        toId: creditId,
        amountCents: STATE_CREDIT_CENTS,
        occurredAt: todayInBogota(),
      });
      await seedDebt({ id: zeroId, name: zeroName, owedCents: 0, terms });
      await seedDebt({ id: owingId, name: owingName, owedCents: STATE_OWING_CENTS, terms });
      // The same overpayment on a liability with no terms (RF-79).
      await seedDebt({ id: bareCreditId, name: bareCreditName, owedCents: 0 });
      await seedPayment({
        fromId: payerId,
        toId: bareCreditId,
        amountCents: STATE_BARE_CREDIT_CENTS,
        occurredAt: todayInBogota(),
      });
    });

    test.afterAll(async () => {
      await dropAccounts([creditId, zeroId, owingId, bareCreditId, payerId]);
    });

    // The element holding a debt's whole card (phone) or its table row (laptop).
    function rowOf(page: Page, name: string, id: string): Locator {
      return laptop
        ? page.getByRole("table", { name: debts.title }).getByRole("row").filter({ hasText: name })
        : band(page)
            .getByText(name, { exact: true })
            .locator(`xpath=ancestor::*[.//a[@href="/es/planning/debts/${id}"]][1]`);
    }

    function balanceOf(page: Page, name: string, id: string): Locator {
      return figureOf(
        page,
        name,
        laptop ? rowOf(page, name, id).getByRole("cell").nth(6) : null,
      );
    }

    test("in credit: the row reads «A favor $ 150.000» and nothing owed, no minimum, no interest, Corte stays", async ({
      page,
    }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, creditName, creditId)).toBeVisible();

      const figure = await balanceOf(page, creditName, creditId).innerText();
      expect(flat(figure)).toBe(
        debts.inFavour.replace("{amount}", `$ ${groupedPesos(STATE_CREDIT_CENTS)}`),
      );
      expect(figure).not.toContain(MINUS);

      const row = flat(await rowOf(page, creditName, creditId).innerText());
      expect(row).not.toContain("Debes");
      if (laptop) {
        const cells = rowOf(page, creditName, creditId).getByRole("cell");
        // Minimum and monthly interest columns are not drawn for a credit.
        expect(await cells.nth(3).innerText()).not.toMatch(/\d/);
        expect(await cells.nth(2).innerText()).not.toMatch(/\d/);
        expect(await cells.nth(4).innerText()).toMatch(/\d/);
      } else {
        expect(row).not.toContain(debts.minimumPayment);
        expect(row).toContain(debts.cutOff);
      }
    });

    test("in credit: the figure carries the accent tone, the owing one does not", async ({
      page,
    }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, creditName, creditId)).toBeVisible();

      const accent = await accentInk(page);
      expect(await inkOf(balanceOf(page, creditName, creditId))).toBe(accent);
      expect(await inkOf(balanceOf(page, owingName, owingId))).not.toBe(accent);
    });

    test("in credit: the cupo disponible is the limit plus the credit", async ({ page }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, creditName, creditId)).toBeVisible();

      const available = pesos(STATE_LIMIT_CENTS + STATE_CREDIT_CENTS);
      if (laptop) {
        const cell = rowOf(page, creditName, creditId).getByRole("cell").nth(1);
        expect(digitsIn(await cell.innerText())).toBe(available);
      } else {
        expect(flat(await rowOf(page, creditName, creditId).innerText())).toContain(
          debts.availableCredit.replace("{amount}", `$ ${groupedPesos(STATE_LIMIT_CENTS + STATE_CREDIT_CENTS)}`),
        );
      }
    });

    test("owing is unchanged: the figure, the minimum and the cupo read as before", async ({
      page,
    }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, owingName, owingId)).toBeVisible();

      expect(flat(await balanceOf(page, owingName, owingId).innerText())).toBe(
        `$ ${groupedPesos(STATE_OWING_CENTS)}`,
      );
      const row = rowOf(page, owingName, owingId);
      const text = flat(await row.innerText());
      expect(text).not.toContain("A favor");
      if (laptop) {
        const cells = row.getByRole("cell");
        expect(digitsIn(await cells.nth(3).innerText())).toBe(pesos(STATE_MINIMUM_CENTS));
        expect(digitsIn(await cells.nth(1).innerText())).toBe(
          pesos(STATE_LIMIT_CENTS - STATE_OWING_CENTS),
        );
      } else {
        expect(text).toContain(debts.minimumPayment);
        expect(text).toContain(
          debts.availableCredit.replace(
            "{amount}",
            `$ ${groupedPesos(STATE_LIMIT_CENTS - STATE_OWING_CENTS)}`,
          ),
        );
      }
    });

    test("at zero: the figure is «$ 0» in the normal ink, with no minimum", async ({ page }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, zeroName, zeroId)).toBeVisible();

      const figure = await balanceOf(page, zeroName, zeroId).innerText();
      expect(flat(figure)).toBe("$ 0");

      const accent = await accentInk(page);
      expect(await inkOf(balanceOf(page, zeroName, zeroId))).not.toBe(accent);
      expect(await inkOf(balanceOf(page, zeroName, zeroId))).toBe(
        await inkOf(balanceOf(page, owingName, owingId)),
      );

      if (laptop) {
        expect(
          await rowOf(page, zeroName, zeroId).getByRole("cell").nth(3).innerText(),
        ).not.toMatch(/\d/);
      } else {
        expect(flat(await rowOf(page, zeroName, zeroId).innerText())).not.toContain(
          debts.minimumPayment,
        );
      }
    });

    test("in credit, the row: «A favor $ 150.000» is one element in the accent, with no sign", async ({
      page,
    }) => {
      await page.goto("/es/planning/debts");
      await expect(rowOf(page, creditName, creditId)).toBeVisible();

      const whole = debts.inFavour.replace("{amount}", `$ ${groupedPesos(STATE_CREDIT_CENTS)}`);
      const holders = await holdersOf(balanceOf(page, creditName, creditId), whole);
      expect(holders.map((holder) => holder.text)).toEqual([whole]);
      expect(holders[0].ink).toBe(await accentInk(page));
      expect(whole).not.toMatch(/[+\u2212]/);
      expect(flat(await balanceOf(page, creditName, creditId).innerText())).not.toMatch(
        /[+\u2212]/,
      );
    });

    test("in credit, the detail: every «A favor $ 150.000» is one element in the accent, with no sign", async ({
      page,
    }) => {
      await page.goto(`/es/planning/debts/${creditId}`);
      await expect(page.getByRole("heading", { name: creditName, exact: true })).toBeVisible();

      const whole = debts.inFavour.replace("{amount}", `$ ${groupedPesos(STATE_CREDIT_CENTS)}`);
      // The hero under the title, the saldo tile and the open period.
      const holders = await holdersOf(page.getByRole("main"), whole);
      expect(holders).toHaveLength(3);
      const accent = await accentInk(page);
      for (const holder of holders) expect(holder.ink).toBe(accent);
      expect(flat(await page.getByRole("main").innerText())).not.toMatch(/[+\u2212]/);
    });

    // The abono dialog's balance field, beside the debt's name (DeudasAbonarAFavorMovil).
    async function openPayDialog(page: Page, id: string, name: string) {
      await page.goto(`/es/planning/debts/${id}`);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await page.getByRole("button", { name: debts.rowPay, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      return {
        dialog,
        balance: dialog
          .getByText(debts.tableBalance, { exact: true })
          .locator("xpath=following-sibling::*[1]"),
        name: dialog.getByText(name, { exact: true }),
      };
    }

    test("abonar a card in credit: the balance reads «A favor $ 150.000» whole in the accent", async ({
      page,
    }) => {
      const { balance } = await openPayDialog(page, creditId, creditName);
      const whole = debts.inFavour.replace("{amount}", `$ ${groupedPesos(STATE_CREDIT_CENTS)}`);

      expect(flat(await balance.innerText())).toBe(whole);
      const holders = await holdersOf(balance, whole);
      expect(holders).toHaveLength(1);
      expect(holders[0].ink).toBe(await accentInk(page));
      expect(flat(await balance.innerText())).not.toMatch(/[+\u2212]/);
    });

    test("abonar a card that owes: the balance is the owed amount in the normal ink", async ({
      page,
    }) => {
      const { balance, name } = await openPayDialog(page, owingId, owingName);

      expect(flat(await balance.innerText())).toBe(`$ ${groupedPesos(STATE_OWING_CENTS)}`);
      const ink = (await holdersOf(balance, flat(await balance.innerText())))[0].ink;
      expect(ink).not.toBe(await accentInk(page));
      expect(ink).toBe(await inkOf(name));
    });

    test("abonar a card at zero: the balance is «$ 0» in the normal ink", async ({ page }) => {
      const { balance, name } = await openPayDialog(page, zeroId, zeroName);

      expect(flat(await balance.innerText())).toBe("$ 0");
      const ink = (await holdersOf(balance, "$ 0"))[0].ink;
      expect(ink).not.toBe(await accentInk(page));
      expect(ink).toBe(await inkOf(name));
    });

    if (laptop) {
      test("the tiles never count a credit: the total and the interest are the owing cards' alone", async ({
        page,
      }) => {
        const shown = band(page);

        // Both projects seed cards for this one user, so the expectation is the
        // database's at assert time: what every pocket owes, a credit adding
        // nothing to the total and nothing to the interest. Netting the credit
        // off would read 150.000 short of it.
        await expectFundTotals(async () => {
          await page.goto("/es/planning/debts");
          await expect(pesoTile(shown, debts.tileTotal)).toBeVisible();
          return {
            owed: await digitsOf(pesoTile(shown, debts.tileTotal)),
            interest: await digitsOf(pesoTile(shown, debts.tileMonthlyInterest)),
          };
        });

        // On the render that matched, the credit is drawn and adds no interest
        // of its own; the owing card's is the twelfth-root step of its rate.
        const rows = await readAllRows(page, 8);
        const named = (name: string) =>
          rows.find((cells) => cells[0].split("\n")[0].trim() === name);
        expect(named(creditName)).toBeDefined();
        expect(named(creditName)![2]).not.toMatch(/\d/);
        expect(
          Math.abs(digitsIn(named(owingName)![2]) - pesos(STATE_OWING_INTEREST_CENTS)),
        ).toBeLessThanOrEqual(1);
      });
    }

    test("in credit, the detail: «A favor $ 150.000», the cupo is the limit plus the credit, and nothing reads it as owed", async ({
      page,
    }) => {
      await page.goto(`/es/planning/debts/${creditId}`);
      await expect(page.getByRole("heading", { name: creditName, exact: true })).toBeVisible();

      const main = page.getByRole("main");
      const credit = `$ ${groupedPesos(STATE_CREDIT_CENTS)}`;
      const inFavour = debts.inFavour.replace("{amount}", credit);

      // The header, the saldo tile and the open period each state the credit,
      // and every time it is on the page it reads «A favor», never as a debt.
      const text = flat(await main.innerText());
      expect(text.split(inFavour).length - 1).toBe(3);
      expect(text.split(credit).length - 1).toBe(3);
      expect(text).not.toContain(MINUS);

      const saldo = tileValue(main, debts.tableBalance).first();
      expect(flat(await saldo.innerText())).toBe(inFavour);
      expect(await inkOf(saldo)).toBe(await accentInk(page));
      expect(flat(await openPeriodBalance(page).innerText())).toBe(inFavour);

      // Nothing is due: no next payment and no minimum line in the open period.
      expect(
        await main
          .getByText(debts.tileNextPayment, { exact: true })
          .locator("xpath=following-sibling::*[1]")
          .innerText(),
      ).toBe(NO_VALUE);
      await expect(
        page
          .getByRole("heading", { name: installments.currentPeriod, exact: true })
          .locator("xpath=../..")
          .getByText(installments.statementMinimum, { exact: true }),
      ).toHaveCount(0);

      // The cupo adds the credit to the limit.
      expect(await digitsOf(tileValue(main, debts.tileAvailableCredit))).toBe(
        pesos(STATE_LIMIT_CENTS + STATE_CREDIT_CENTS),
      );
      expect(
        flat(
          await main
            .getByText(debts.tileAvailableCredit, { exact: true })
            .locator("xpath=following-sibling::*[2]")
            .innerText(),
        ),
      ).toBe(
        debts.tileAvailableCreditNote.replace(
          "{amount}",
          `$ ${groupedPesos(STATE_LIMIT_CENTS)}`,
        ),
      );

      // The abono states the credit whole, in the accent, as the detail does.
      await page.getByRole("button", { name: debts.rowPay, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect(
        flat(
          await dialog
            .getByText(debts.tableBalance, { exact: true })
            .locator("xpath=following-sibling::*[1]")
            .innerText(),
        ),
      ).toBe(inFavour);
      await dialog.getByRole("button", { name: common.cancel, exact: true }).click();
      await expect(dialog).toBeHidden();
    });

    test("in credit with no terms, the detail reads «A favor» and never the credit as owed", async ({
      page,
    }) => {
      await page.goto(`/es/planning/debts/${bareCreditId}`);
      await expect(
        page.getByRole("heading", { name: bareCreditName, exact: true }),
      ).toBeVisible();

      const main = page.getByRole("main");
      const credit = `$ ${groupedPesos(STATE_BARE_CREDIT_CENTS)}`;
      const inFavour = debts.inFavour.replace("{amount}", credit);

      // The header and the saldo tile; a debt with no terms has no open period.
      const text = flat(await main.innerText());
      expect(text.split(inFavour).length - 1).toBe(2);
      expect(text.split(credit).length - 1).toBe(2);
      expect(flat(await tileValue(main, debts.tableBalance).first().innerText())).toBe(
        inFavour,
      );
    });

    if (laptop) {
      test("the balance cell keeps clear of «Vence», with terms and without", async ({
        page,
      }) => {
        for (const name of [creditName, bareCreditName]) {
          await page.goto("/es/planning/debts");
          await pageToRow(page, name);
          const cells = page
            .getByRole("table", { name: debts.title })
            .getByRole("row")
            .filter({ hasText: name })
            .getByRole("cell");
          const due = (await cells.nth(5).boundingBox())!;
          const balance = (await cells.nth(6).boundingBox())!;
          // The figure starts at least a body gap past the date's end.
          expect(balance.x - (due.x + due.width)).toBeGreaterThanOrEqual(16);
          expect(flat(await cells.nth(6).innerText())).toBe(
            debts.inFavour.replace(
              "{amount}",
              `$ ${groupedPesos(name === creditName ? STATE_CREDIT_CENTS : STATE_BARE_CREDIT_CENTS)}`,
            ),
          );
        }
      });
    }

    test("planning tile: «Deudas» totals what is owed and leaves the credit out", async ({
      page,
    }) => {
      // Both projects seed cards for this one user, so the tile's total is not
      // this describe's alone. The expectation comes from the same scope at
      // assert time: what every liability owes in pesos, a credit adding nothing.
      // The page's read falls between two of ours, so it names one of them unless
      // a second seed landed in the window, and then the poll takes it again.
      async function owedNow(): Promise<number> {
        let owed = 0;
        await asHarnessUser(async (tx) => {
          const [row] = await tx<{ owed: string }[]>`
            select coalesce(sum(greatest(0, -b.balance_cents)), 0)::text as owed
            from account_balances b
            join accounts a on a.id = b.id
            where a.kind = 'liability' and a.archived_at is null and b.currency = 'COP'
              and a.owner_user_id = ${scope.userId}`;
          owed = Number(row.owed);
        });
        return owed;
      }

      await expect
        .poll(
          async () => {
            const before = await owedNow();
            await page.goto("/es/planning");
            const summary = page
              .getByText(/^\$\s[\d.]+\s(·|en deudas)/)
              .filter({ visible: true });
            await expect(summary).toHaveCount(1);
            const text = flat(await summary.innerText());
            const after = await owedNow();
            return [before, after].some((owed) =>
              text.startsWith(`$ ${groupedPesos(owed)} `),
            )
              ? "match"
              : `${text} | ${before} ${after}`;
          },
          { timeout: 25_000 },
        )
        .toBe("match");
    });
  });

  test.describe(`${bandLabel}: a pocket in another currency`, () => {
    test.use({ viewport: { width, height: 900 } });

    const pocketId = randomUUID();
    const pocketName = `Tarjeta con bolsillo ${bandLabel} ${stamp}`;
    const refundCategoryId = randomUUID();
    const POCKET_OWED_CENTS = 8_000_000;
    const POCKET_USD_CREDIT_CENTS = 2_000;

    test.beforeAll(async () => {
      await seedDebt({
        id: pocketId,
        name: pocketName,
        owedCents: POCKET_OWED_CENTS,
        terms: { debtKind: "revolving", annualRate: STATE_RATE },
      });
      await asHarnessUser(async (tx) => {
        await tx`
          insert into categories (id, owner_user_id, name, kind, color)
          values (${refundCategoryId}, ${scope.userId}, ${`Reembolso ${bandLabel} ${stamp}`}, 'income', '#4C8C4A')`;
        const [movement] = await tx<{ id: string }[]>`
          insert into transactions (
            to_account_id, amount_cents, occurred_at, description,
            currency, counter_amount_cents, counter_is_estimate)
          values (
            ${pocketId}, ${POCKET_USD_CREDIT_CENTS}, ${todayInBogota()},
            ${`Reembolso en dólares ${stamp}`}, 'USD', 8000000, true)
          returning id`;
        await tx`
          insert into transaction_splits (transaction_id, category_id, amount_cents)
          values (${movement.id}, ${refundCategoryId}, ${POCKET_USD_CREDIT_CENTS})`;
      });
    });

    test.afterAll(async () => {
      await dropAccounts([pocketId]);
      await fixtureSql`delete from categories where id = ${refundCategoryId}`;
    });

    test("the dollar pocket reads «A favor US$ 20» under the peso owed «$ 80.000»", async ({
      page,
    }) => {
      await page.goto("/es/planning/debts");

      const cell = laptop
        ? page
            .getByRole("table", { name: debts.title })
            .getByRole("row")
            .filter({ hasText: pocketName })
            .getByRole("cell")
            .nth(6)
        : cardOwed(page, pocketName);
      await expect(cell).toBeVisible();

      const lines = (await cell.innerText())
        .split("\n")
        .map((line) => flat(line))
        .filter((line) => line !== "");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`$ ${groupedPesos(POCKET_OWED_CENTS)}`);
      expect(lines[1]).toMatch(/^A favor US\$ 20([.,]00)?$/);
    });
  });
}

// ---------------------------------------------------------------------------
// A card in credit with a dollar purchase still to bill, and the next payment
// of a fund with nothing to pay (RF-80, RF-83, RF-123, RF-124; `docs/DESIGN.md`
// § Debts, Q9 a; boards DeudasAFavorPorFacturar, DeudasProximoPagoSinDeudaMovil).
//
// Both read a whole fund, so they run as the second identity, whose personal
// fund no other spec of this file seeds: every figure below is that fund's alone
// and the expectations are constants. A session lock keyed like the plain
// member's describe keeps a group from forming around that identity meanwhile.
// ---------------------------------------------------------------------------

/**
 * How a name sits in the browser: each word's characters on one line or not, the
 * lines it takes, its wrapping properties and where it ends. A name cut inside a
 * word has a word whose characters sit on two lines.
 */
async function nameLayout(name: Locator) {
  return name.evaluate((el) => {
    const tops: number[] = [];
    const split: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const match of text.matchAll(/\S+/g)) {
        const own: number[] = [];
        for (let i = 0; i < match[0].length; i++) {
          const range = document.createRange();
          range.setStart(node, match.index + i);
          range.setEnd(node, match.index + i + 1);
          const rect = range.getClientRects()[0];
          if (rect) own.push(Math.round(rect.top));
        }
        if (own.some((top) => Math.abs(top - own[0]) > 2)) split.push(match[0]);
        tops.push(...own);
      }
    }
    const lines = tops.filter((top, i) => tops.findIndex((t) => Math.abs(t - top) <= 2) === i);
    const style = getComputedStyle(el);
    return {
      split,
      lines: lines.length,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      ellipsis: style.textOverflow,
      bottom: el.getBoundingClientRect().bottom,
    };
  });
}

const Q9_CREDIT_CENTS = 800_000;
const Q9_USD_CENTS = 2_500;
const Q9_ESTIMATE_CENTS = 10_500_000;
const Q9_OWED_CENTS = 8_000_000;
const Q9_PESO_OWED_CENTS = 4_000_000;
const Q9_MINIMUM_CENTS = 1_000_000;

type MemberTx = postgres.TransactionSql;

async function asMember(fn: (tx: MemberTx) => Promise<void>): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: scope.memberUserId,
      role: "authenticated",
      aud: "authenticated",
    })}, true)`;
    await fn(tx);
  });
}

type MemberCard = {
  id: string;
  name: string;
  // Owed in pesos at the opening, or credited by an overpayment from `payerId`.
  owedCents?: number;
  creditCents?: number;
  // A dollar purchase on the card; `estimateCents` null leaves it with no peso
  // estimate at all.
  usd?: { cents: number; estimateCents: number | null };
  // A dollar refund beside the purchase, estimated in pesos.
  usdRefund?: { cents: number; estimateCents: number };
  withMinimum?: boolean;
};

const MEMBER_TERMS_RATE = 0.2;

test.describe("a card in credit with a dollar purchase, and the next payment", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  const lockKey = `debts.spec fund ${scope.userId}`;
  let lock: postgres.Sql | null = null;
  let seeded: string[] = [];
  let categories: string[] = [];

  test.beforeAll(async () => {
    lock = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    await lock`select pg_advisory_lock(hashtext(${lockKey}))`;
    // No fund around the second identity, so its debts are its own alone.
    await clearGroup();
  });

  test.afterAll(async () => {
    if (lock !== null) {
      await lock`select pg_advisory_unlock(hashtext(${lockKey}))`;
      await lock.end();
      lock = null;
    }
  });

  test.afterEach(async () => {
    const ids = seeded;
    const cats = categories;
    seeded = [];
    categories = [];
    if (ids.length === 0) return;
    await asMember(async (tx) => {
      await tx`
        delete from transactions
        where from_account_id in ${tx(ids)} or to_account_id in ${tx(ids)}`;
      await tx`delete from debt_terms where account_id in ${tx(ids)}`;
      await tx`delete from accounts where id in ${tx(ids)}`;
    });
    if (cats.length > 0) await fixtureSql`delete from categories where id in ${fixtureSql(cats)}`;
  });

  async function seedFund(cards: MemberCard[]): Promise<void> {
    const payerId = randomUUID();
    const categoryId = randomUUID();
    seeded.push(payerId, ...cards.map((card) => card.id));
    categories.push(categoryId);

    await asMember(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (
          ${payerId}, ${scope.memberUserId}, ${`Cuenta pagadora Q9 ${stamp}`}, 'asset', 'bank',
          ${900_000_000}, ${todayInBogota()})`;
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${categoryId}, ${scope.memberUserId}, ${`Compra Q9 ${stamp}`}, 'expense', '#4C8C4A')`;

      for (const card of cards) {
        await tx`
          insert into accounts (
            id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
          values (
            ${card.id}, ${scope.memberUserId}, ${card.name}, 'liability', 'card',
            ${-(card.owedCents ?? 0)}, ${todayInBogota()})`;
        await tx`
          insert into debt_terms (
            account_id, debt_kind, annual_rate, minimum_payment_cents,
            credit_limit_cents, statement_cut_off_day, payment_due_day)
          values (
            ${card.id}, 'revolving', ${MEMBER_TERMS_RATE},
            ${card.withMinimum ? Q9_MINIMUM_CENTS : null},
            ${card.withMinimum ? 100_000_000 : null},
            ${card.withMinimum ? 15 : null}, ${card.withMinimum ? 5 : null})`;

        if (card.creditCents !== undefined) {
          await tx`
            insert into transactions (
              from_account_id, to_account_id, amount_cents, occurred_at, description)
            values (${payerId}, ${card.id}, ${card.creditCents}, ${todayInBogota()}, ${`Abono Q9 ${stamp}`})`;
        }
        if (card.usd !== undefined) {
          // The ledger refuses a dollar movement with no peso amount, and a
          // billed one leaves no dollar pocket, so a dollar balance with no
          // estimate behind it is written by taking the estimate off a valid
          // purchase with the triggers off: the row the screen must draw
          // without a parenthesis.
          const [movement] = await tx<{ id: string }[]>`
            insert into transactions (
              from_account_id, amount_cents, occurred_at, description,
              currency, counter_amount_cents, counter_is_estimate)
            values (
              ${card.id}, ${card.usd.cents}, ${todayInBogota()}, ${`Compra en dólares Q9 ${stamp}`},
              'USD', ${card.usd.estimateCents ?? 1}, true)
            returning id`;
          await tx`
            insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${movement.id}, ${categoryId}, ${card.usd.cents})`;
          if (card.usd.estimateCents === null) {
            await tx`set local session_replication_role = replica`;
            await tx`
              update transactions
              set counter_is_estimate = false, counter_amount_cents = null
              where id = ${movement.id}`;
            await tx`set local session_replication_role = origin`;
          }
        }
        if (card.usdRefund !== undefined) {
          const refundCategoryId = randomUUID();
          categories.push(refundCategoryId);
          await tx`
            insert into categories (id, owner_user_id, name, kind, color)
            values (${refundCategoryId}, ${scope.memberUserId}, ${`Reembolso Q9 ${stamp}`}, 'income', '#4C8C4A')`;
          const [refund] = await tx<{ id: string }[]>`
            insert into transactions (
              to_account_id, amount_cents, occurred_at, description,
              currency, counter_amount_cents, counter_is_estimate)
            values (
              ${card.id}, ${card.usdRefund.cents}, ${todayInBogota()}, ${`Reembolso en dólares Q9 ${stamp}`},
              'USD', ${card.usdRefund.estimateCents}, true)
            returning id`;
          await tx`
            insert into transaction_splits (transaction_id, category_id, amount_cents)
            values (${refund.id}, ${refundCategoryId}, ${card.usdRefund.cents})`;
        }
      }
    });
  }

  for (const [bandLabel, width] of [
    ["phone", 360],
    ["laptop", 1280],
  ] as const) {
    const laptop = width >= 1024;

    test.describe(bandLabel, () => {
      test.use({ viewport: { width, height: 900 } });

      function rowOf(page: Page, name: string, id: string): Locator {
        return laptop
          ? page.getByRole("table", { name: debts.title }).getByRole("row").filter({ hasText: name })
          : band(page)
              .getByText(name, { exact: true })
              .locator(`xpath=ancestor::*[.//a[@href="/es/planning/debts/${id}"]][1]`);
      }

      const FULL_LINE =
        /^A\sfavor\s\$\s8\.000\s·\sDebes\sUS\$\s25([.,]00)?\s\(≈\s\$\s105\.000\spor\sfacturar\)$/;
      const BILLED_LINE = /^A\sfavor\s\$\s8\.000\s·\sDebes\sUS\$\s25([.,]00)?$/;
      const START_OF_LINE = /^A\sfavor\s\$\s8\.000\s·\sDebes\sUS\$\s25/;

      function lineOf(page: Page, card: MemberCard): Locator {
        return rowOf(page, card.name, card.id).getByText(START_OF_LINE);
      }

      test("Q9: the row reads the credit, what is owed in dollars and what is still to bill", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        await seedFund([card]);
        await page.goto("/es/planning/debts");

        const line = lineOf(page, card);
        await expect(line).toHaveText(FULL_LINE);

        // «A favor $ 8.000» is the accent's and the rest is the normal ink.
        const accent = await accentInk(page);
        const holders = await holdersOf(line, "A favor $ 8.000");
        expect(holders).toHaveLength(1);
        expect(holders[0].ink).toBe(accent);
        for (const rest of [/Debes/, /por facturar/]) {
          const inks = await inkOfText(line, rest);
          expect(inks.length).toBeGreaterThan(0);
          for (const ink of inks) expect(ink).not.toBe(accent);
        }
      });

      test("Q9: at the phone the name reads whole under no ellipsis and the line sits under it, wrapping only at its dots", async ({
        page,
      }) => {
        test.skip(laptop, "the laptop table keeps M5's columns");
        const card: MemberCard = {
          id: randomUUID(),
          name: "Mastercard Black Bancolombia",
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        await seedFund([card]);
        await page.goto("/es/planning/debts");

        const line = lineOf(page, card);
        await expect(line).toHaveText(FULL_LINE);

        // The locator waits; the measures read it once it is there.
        const name = rowOf(page, card.name, card.id).getByText(card.name, { exact: true });
        await expect(name).toBeVisible();
        const layout = await nameLayout(name);
        expect(layout.split).toEqual([]);
        expect(layout.lines).toBeLessThanOrEqual(2);
        expect(layout.ellipsis).not.toBe("ellipsis");
        expect(layout.overflowWrap).not.toBe("anywhere");
        expect(layout.wordBreak).not.toBe("break-all");

        // The line sits under the name, never beside it, and spans the card's width.
        const nameBox = (await name.boundingBox())!;
        const lineBox = (await line.boundingBox())!;
        const cardBox = (await rowOf(page, card.name, card.id).boundingBox())!;
        expect(lineBox.y).toBeGreaterThanOrEqual(layout.bottom - 1);
        expect(lineBox.x).toBeLessThanOrEqual(nameBox.x);
        expect(lineBox.width).toBeGreaterThan(cardBox.width / 2);

        // The board wraps the line at a dot or before the parenthesis, never inside a word or a figure.
        const breaks = await line.evaluate((el) => {
          const marks: { top: number; ch: string }[] = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent ?? "";
            for (let i = 0; i < text.length; i++) {
              if (/\s/.test(text[i])) continue;
              const range = document.createRange();
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const rect = range.getClientRects()[0];
              if (rect) marks.push({ top: Math.round(rect.top), ch: text[i] });
            }
          }
          const starts: string[] = [];
          for (let i = 1; i < marks.length; i++) {
            if (marks[i].top > marks[i - 1].top + 2) starts.push(marks[i].ch);
          }
          return starts;
        });
        for (const start of breaks) expect(["·", "("]).toContain(start);
      });

      test("Q9: with no estimate pending the row names the dollars and draws no parenthesis", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 sin estimado ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: null },
        };
        await seedFund([card]);
        await page.goto("/es/planning/debts");

        await expect(lineOf(page, card)).toHaveText(BILLED_LINE);
        await expect(rowOf(page, card.name, card.id)).not.toContainText("(");
      });

      test("Q9: Abonar, from the row and from the detail, reads the row's whole line under the card's name", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 abono ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        await seedFund([card]);

        async function checkDialog() {
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          const balance = dialog
            .getByText(debts.tableBalance, { exact: true })
            .locator("xpath=following-sibling::*[1]");
          await expect(balance).toHaveText(FULL_LINE);

          // «A favor» in the accent, «Debes» bold in the normal ink, the parenthesis muted.
          const accent = await accentInk(page);
          const credit = await holdersOf(balance, "A favor $ 8.000");
          expect(credit).toHaveLength(1);
          expect(credit[0].ink).toBe(accent);
          const owedInks = await inkOfText(balance, /Debes/);
          expect(owedInks.length).toBeGreaterThan(0);
          for (const ink of owedInks) expect(ink).not.toBe(accent);
          const weight = await balance
            .getByText(/Debes/)
            .first()
            .evaluate((el) => Number(getComputedStyle(el).fontWeight));
          expect(weight).toBeGreaterThanOrEqual(600);
          const muted = await inkOfText(balance, /por facturar/);
          expect(muted.length).toBeGreaterThan(0);
          for (const ink of muted) {
            expect(ink).not.toBe(accent);
            expect(ink).not.toBe(owedInks[0]);
          }
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        }

        await page.goto("/es/planning/debts");
        if (laptop) {
          await rowMenu(page, card.name).click();
          await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();
        } else {
          await rowOf(page, card.name, card.id)
            .getByRole("button", { name: debts.rowPay, exact: true })
            .click();
        }
        await checkDialog();

        await page.goto(`/es/planning/debts/${card.id}`);
        await expect(page.getByRole("heading", { name: card.name, exact: true })).toBeVisible();
        await page.getByRole("button", { name: debts.rowPay, exact: true }).click();
        await checkDialog();
      });

      test("Q9: the detail's Saldo tile reads the big figure and the rest of the line under it", async ({
        page,
      }) => {
        const credit: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 saldo a favor ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        const dollars: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 saldo dólares ${bandLabel} ${stamp}`,
          usd: { cents: 2_000, estimateCents: 8_400_000 },
        };
        await seedFund([credit, dollars]);
        const fontSize = (el: Locator) =>
          el.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));

        await page.goto(`/es/planning/debts/${credit.id}`);
        await expect(page.getByRole("heading", { name: credit.name, exact: true })).toBeVisible();
        const accent = await accentInk(page);
        const main = page.getByRole("main");
        const label = main.getByText(debts.tableBalance, { exact: true }).first();
        const big = label.locator("xpath=following-sibling::*[1]");
        const rest = label.locator("xpath=following-sibling::*[2]");
        await expect(big).toHaveText(/^A\sfavor\s\$\s8\.000$/);
        expect(await inkOf(big)).toBe(accent);
        expect(await fontSize(big)).toBeGreaterThanOrEqual(20);
        await expect(rest).toHaveText(
          /^·\sDebes\sUS\$\s25([.,]00)?\s\(≈\s\$\s105\.000\spor\sfacturar\)$/,
        );
        expect(await fontSize(rest)).toBeLessThan(await fontSize(big));
        const owedInks = await inkOfText(rest, /Debes/);
        expect(owedInks.length).toBeGreaterThan(0);
        for (const ink of owedInks) expect(ink).not.toBe(accent);
        const muted = await inkOfText(rest, /por facturar/);
        expect(muted.length).toBeGreaterThan(0);
        for (const ink of muted) expect(ink).not.toBe(owedInks[0]);
        expect((await big.boundingBox())!.y + (await big.boundingBox())!.height).toBeLessThanOrEqual(
          (await rest.boundingBox())!.y + 1,
        );

        await page.goto(`/es/planning/debts/${dollars.id}`);
        await expect(page.getByRole("heading", { name: dollars.name, exact: true })).toBeVisible();
        const owesLabel = page.getByRole("main").getByText(debts.tableBalance, { exact: true }).first();
        const owes = owesLabel.locator("xpath=following-sibling::*[1]");
        await expect(owes).toHaveText(/^Debes\sUS\$\s20([.,]00)?$/);
        expect(await inkOf(owes)).not.toBe(accent);
        expect(await fontSize(owes)).toBeGreaterThanOrEqual(20);
      });

      test("Q9: Abonar with a dollar refund beside the purchase reads the estimate net of it, on the row and the detail", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 reembolso ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
          usdRefund: { cents: 500, estimateCents: 2_000_000 },
        };
        await seedFund([card]);
        // US$ 25 bought and US$ 5 refunded: US$ 20 owed, 10.500.000 less 2.000.000 to bill.
        const netLine =
          /^A\sfavor\s\$\s8\.000\s·\sDebes\sUS\$\s20([.,]00)?\s\(≈\s\$\s85\.000\spor\sfacturar\)$/;
        const balanceOf = (dialog: Locator) =>
          dialog
            .getByText(debts.tableBalance, { exact: true })
            .locator("xpath=following-sibling::*[1]");

        await page.goto("/es/planning/debts");
        if (laptop) {
          await rowMenu(page, card.name).click();
          await page.getByRole("menuitem", { name: debts.rowPay, exact: true }).click();
        } else {
          await rowOf(page, card.name, card.id)
            .getByRole("button", { name: debts.rowPay, exact: true })
            .click();
        }
        await expect(balanceOf(page.getByRole("dialog"))).toHaveText(netLine);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();

        await page.goto(`/es/planning/debts/${card.id}`);
        await expect(page.getByRole("heading", { name: card.name, exact: true })).toBeVisible();
        await page.getByRole("button", { name: debts.rowPay, exact: true }).click();
        await expect(balanceOf(page.getByRole("dialog"))).toHaveText(netLine);
      });

      test("Q9: the figures are never summed, Deuda total in pesos does not move", async ({
        page,
      }) => {
        const credited: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 suma ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        const peso: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 en pesos ${bandLabel} ${stamp}`,
          owedCents: Q9_PESO_OWED_CENTS,
        };
        await seedFund([credited, peso]);
        await page.goto("/es/planning/debts");
        await expect(lineOf(page, credited)).toHaveText(FULL_LINE);

        const shown = band(page);
        const totals = laptop
          ? tileValue(shown, debts.tileTotal)
          : shown
              .getByText(new RegExp(`^${debts.total}`))
              .locator("xpath=following-sibling::*[1]");
        await expect(totals).toHaveCount(2);
        // Pesos first: only what the peso card owes, with neither the credit
        // taken off, nor the dollars added, nor the estimate.
        expect(await digitsOf(totals.nth(0))).toBe(pesos(Q9_PESO_OWED_CENTS));
        // The dollar set: what the purchase owes, in dollars.
        expect(await digitsOf(totals.nth(1))).toBe(Q9_USD_CENTS);
        expect(await totals.nth(1).innerText()).toContain("US$");
      });

      test("Q9: a card that owes pesos keeps today's drawing beside the dollar pocket", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta Q9 debe ${bandLabel} ${stamp}`,
          owedCents: Q9_OWED_CENTS,
          usd: { cents: Q9_USD_CENTS, estimateCents: Q9_ESTIMATE_CENTS },
        };
        await seedFund([card]);
        await page.goto("/es/planning/debts");

        const figure = laptop
          ? rowOf(page, card.name, card.id).getByRole("cell").nth(6)
          : band(page)
              .getByText(card.name, { exact: true })
              .locator("xpath=../following-sibling::*[1]");
        await expect(figure).toBeVisible();
        const lines = (await figure.innerText())
          .split("\n")
          .map((line) => flat(line))
          .filter((line) => line !== "");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe(`$ ${groupedPesos(Q9_OWED_CENTS)}`);
        expect(lines[1]).toMatch(/^US\$ 25([.,]00)?$/);
      });

      test("Próximo pago: a fund whose only due card is in credit reads «—» and names no date", async ({
        page,
      }) => {
        const card: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta a favor con pago ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          withMinimum: true,
        };
        await seedFund([card]);
        await page.goto("/es/planning/debts");
        await expect(rowOf(page, card.name, card.id)).toBeVisible();

        const label = band(page).getByText(debts.tileNextPayment, { exact: true }).first();
        await expect(label).toBeVisible();
        const tile = label.locator("xpath=..");
        // textContent: the label is drawn in capitals, which innerText returns.
        expect(flat((await tile.textContent()) ?? "")).toMatch(
          new RegExp(`^${debts.tileNextPayment}\\s*${NO_VALUE}$`),
        );
      });

      test("Próximo pago: a fund with a card that owes names that card's minimum and date", async ({
        page,
      }) => {
        const credited: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta a favor sin pago ${bandLabel} ${stamp}`,
          creditCents: Q9_CREDIT_CENTS,
          withMinimum: true,
        };
        const owing: MemberCard = {
          id: randomUUID(),
          name: `Tarjeta con pago ${bandLabel} ${stamp}`,
          owedCents: Q9_OWED_CENTS,
          withMinimum: true,
        };
        await seedFund([credited, owing]);
        await page.goto("/es/planning/debts");
        await expect(rowOf(page, owing.name, owing.id)).toBeVisible();

        const label = band(page).getByText(debts.tileNextPayment, { exact: true }).first();
        const text = flat(
          await (laptop ? label.locator("xpath=..") : band(page)).innerText(),
        );
        if (laptop) {
          // The tile: the owing card's minimum, then its date and its name.
          expect(digitsIn(await label.locator("xpath=following-sibling::*[1]").innerText())).toBe(
            pesos(Q9_MINIMUM_CENTS),
          );
          expect(text).toMatch(new RegExp(`\\d{1,2} \\p{L}+\\.? · ${owing.name}$`, "u"));
          expect(text).not.toContain(credited.name);
        } else {
          expect(text).toMatch(
            new RegExp(
              `Próximo pago · \\$ ${groupedPesos(Q9_MINIMUM_CENTS)} el \\d{1,2} \\p{L}+`,
              "u",
            ),
          );
        }
      });
    });
  }
});
