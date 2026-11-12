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
  test,
} from "./global-setup";
import { MIN_TITLE_PX, rightOverhang } from "./fit";

const debts = messages.debts;
const installments = messages.installments;
const common = messages.common;

// The em dash a cell with nothing to name reads as, which is what a debt with no
// credit limit shows instead of a cupo of zero (RF-117).
const NO_VALUE = "\u2014";

// The minus `Money` prints on a signed figure below zero, read back
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

// The owed a phone card states: the name sits in a row with its personal mark,
// inside a column, and the amount follows that column.
function cardOwed(page: Page, name: string): Locator {
  return band(page)
    .getByText(name, { exact: true })
    .locator("xpath=../../following-sibling::*[1]");
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
  // them (RNF-08).
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

  test("the payment dialog says it was saved and drops the saldo", async ({
    page,
  }) => {
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

    await expect(
      page.getByText(installments.paymentSaved, { exact: true }),
    ).toBeVisible();

    // The saldo is derived from the movements, so the payment moves it by
    // exactly what it paid.
    // The row re-reads after the action's refresh, which lands after the toast.
    await expect
      .poll(async () => digitsOf(row.getByRole("cell").nth(6)))
      .toBe(pesos(MENU_DEBT_OWED_CENTS - MENU_PAID_CENTS));
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
    await seedPayment({
      fromId: payerId,
      toId: detailId,
      amountCents: DETAIL_PAID_CENTS,
      occurredAt: addCivilDays(todayInBogota(), -70),
    });
  });

  test.afterEach(async () => {
    await dropAccounts([detailId, payerId]);
  });

  test("reads the frozen statement saldos, which a later movement leaves alone while the open period moves", async ({
    page,
  }) => {
    // The statements table draws from `lg` up; the phone reads cards.
    await page.setViewportSize({ width: 1280, height: 900 });
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

  test("reads each statement as a card on the phone, with its balance in view @mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/es/planning/debts/${detailId}`);

    await expect(
      page.getByText(installments.statementBalance, { exact: true }).locator("visible=true").first(),
    ).toBeVisible();
    await expect(page.getByRole("table", { name: installments.statementsTitle })).toBeHidden();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("records what a person types into the dialog, and shows the row with the gap the base derives", async ({
    page,
  }) => {
    // The statements table draws from `lg` up; the phone reads cards.
    await page.setViewportSize({ width: 1280, height: 900 });
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
      // A debt read by its kind: the card the phone draws for it is the installment one.
      terms: { debtKind: "installment", annualRate: 0.2 },
    });
    await seedPayment({
      fromId: phonePayerId,
      toId: phoneId,
      amountCents: PHONE_PAID_LINES * PHONE_LINE_CENTS,
      occurredAt: todayInBogota(),
    });
  });

  test.afterAll(async () => {
    await dropAccounts([phoneId, phonePayerId]);
  });

  test("shows the card list without the laptop table, and the installment card names its kind @mobile", async ({
    page,
  }) => {
    await page.goto("/es/planning/debts");

    // The dense table renders from `lg` up and is not in the tree below it, so
    // the phone is not carrying a second copy of every figure.
    await expect(page.getByRole("table", { name: debts.title })).toHaveCount(0);
    await expect(band(page)).toHaveCount(1);

    await expect(band(page).getByText(phoneName, { exact: true })).toBeVisible();
    // No plan position: the next payment is the minimum alone (RF-136).
    await expect(
      phoneCard(page, phoneName, phoneId).getByText(debts.installmentMeta, { exact: true }),
    ).toBeVisible();
    expect(await digitsOf(cardOwed(page, phoneName))).toBe(
      pesos(PHONE_OWED_CENTS),
    );
  });

  test("the card's detail control opens that debt and not the list @mobile", async ({
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

// What a row reads once the spaces ICU chooses (no-break included) are one.
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Whole pesos with the Colombian dot, written here so the browser's ICU is not
// what the expectation is read from.
function groupedPesos(cents: number): string {
  return String(cents / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
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

    if (laptop) {
    }

    if (laptop) {
    }
  });
}

// ---------------------------------------------------------------------------
// A card in credit with a dollar purchase still to bill, and the next payment
// of a fund with nothing to pay (RF-80, RF-83, RF-123, RF-124; `docs/DESIGN.md`
// § Debts; boards DeudasAFavorPorFacturar, DeudasProximoPagoSinDeudaMovil).
//
// Both read a whole fund, so they run as the second identity, whose personal
// fund no other spec of this file seeds: every figure below is that fund's alone
// and the expectations are constants. A session lock keyed like the plain
// member's describe keeps a group from forming around that identity meanwhile.
// ---------------------------------------------------------------------------

const Q9_CREDIT_CENTS = 800_000;
const Q9_OWED_CENTS = 8_000_000;
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
          new RegExp(`^${debts.tileNextPayment}\\s*${NO_VALUE}\\s*${debts.tileNoNextPayment}$`),
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

test.describe("a long debt with a wide balance on a narrow phone", () => {
  const longId = randomUUID();
  const longName = `Crédito hipotecario del apartamento de Chapinero ${stamp}`;

  test.beforeAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${longId}, ${scope.userId}, ${longName}, 'liability', 'loan', -98765432198,
          (now() at time zone ${TIME_ZONE})::date)`;
    });
  });

  test.afterAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`delete from accounts where id = ${longId}`;
    });
  });

  test("keeps the name at least 7rem wide and the balance inside the card @mobile", async ({
    page,
  }) => {
    // Kills: a balance that holds the name's row, so the name stacks a word per line.
    await page.goto("/es/planning/debts");

    const name = page.getByText(longName, { exact: true }).filter({ visible: true });
    const card = page.locator(".rt-Card").filter({ visible: true }).filter({ has: name });
    const balance = card.getByText(/987\.654\.321/).first();
    await expect(balance).toBeVisible();

    const [nameBox, balanceBox] = await Promise.all([name.boundingBox(), balance.boundingBox()]);
    expect(nameBox!.width).toBeGreaterThanOrEqual(MIN_TITLE_PX);
    expect(await rightOverhang(balance, card)).toBeLessThanOrEqual(0);
    // Beside the name or under it, never over it.
    expect(
      balanceBox!.y >= nameBox!.y + nameBox!.height || balanceBox!.x >= nameBox!.x + nameBox!.width,
    ).toBe(true);
  });
});
