/**
 * One revived write path, end to end through the interface. This is the whole
 * reason the slice exists: on `main` this path raised
 * `42501 permission denied for table accounts`, and no check reached it — layer 1
 * drives `createAccount` in process, but only a browser drives the form, the
 * action and the policy together.
 *
 * The five that follow are the account paths no browser had ever run: the edit,
 * the derived balance (RF-114), the group placement, the delete a movement
 * refuses (RF-11) and the hand-over (RF-61). Each figure is read back from
 * Postgres — from `account_balances` for the balance — so none of them rests on
 * the screen agreeing with itself.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, readScope, seedGroup, test } from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;
const errors = messages.errors;

const scope = readScope();

// Unique per run, so a name asserted on screen can only be this test's row.
const stamp = randomUUID().slice(0, 8);
let serial = 0;

// The word the opening line puts between its figure and its date, taken from the
// copy that writes it: the figure on that line is everything before it.
const OPENING_SEPARATOR = accounts.openingBalanceRow
  .split("</amount>")[1]
  .split("{date}")[0];

// The static tail of "<amount></amount> en {currency}" once the figure tag is
// gone: a second currency's line ends in it, on the phone's card and in the
// laptop's cell alike (RF-121, RF-124).
const CURRENCY_LINE_SUFFIX = accounts.balanceInCurrency.split("</amount>")[1];

function otherCurrencyLabel(currency: string): string {
  return CURRENCY_LINE_SUFFIX.replace("{currency}", currency).trim();
}

// The menu names the row it belongs to, so a card is reached by its own name and
// never by a position among whatever else the list is carrying.
function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

/**
 * The band the width displays. The laptop's table and the phone's cards are both
 * in the DOM at every width, cut apart by CSS alone, so a locator that names no
 * band reaches an account twice and dies on strict mode.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// One account's card: the innermost node carrying both its name and the menu that
// acts on it, so a figure read inside it can only be that account's.
function card(page: Page, name: string): Locator {
  return band(page)
    .locator("div")
    .filter({ has: rowMenu(page, name) })
    .filter({ hasText: name })
    .last();
}

// A labelled line of a card — the label and the figure beside it.
function line(subject: Locator, label: string): Locator {
  return subject.getByText(label, { exact: true }).locator("..");
}

// The pesos a line is showing: COP rounds to the peso, so the digits of the
// figure are the cents behind it divided by a hundred. `\D` throws away the
// sign along with the currency symbol, so this alone can never prove a minus
// made it to the screen (D4) — the raw text has to be read for that.
function pesosOf(text: string): number {
  return Number(text.replace(/\D/g, ""));
}

// `Money`'s own sign, U+2212 (components/ui/money.tsx), never the hyphen a
// keyboard types.
const MINUS = "−";

// The two sides an account may be drawn on, named the same way whichever band
// the width is showing.
type Placement = "personal" | "fund";

/**
 * The placement the displayed band states for an account. The phone heads a run
 * of cards with it and calls the group by its own name, so it is the last band
 * to appear above the card; the laptop's table gives every row a scope cell
 * under the name instead, and nothing at all precedes the first row's.
 */
async function placementOf(
  page: Page,
  name: string,
  fundBand: string,
): Promise<Placement | null> {
  const rows = page
    .getByRole("table", { name: accounts.title })
    .getByRole("row")
    .filter({ hasText: name });

  if ((await rows.count()) > 0) {
    const scope = await rows.getByRole("cell").first().innerText();
    if (scope.includes(accounts.ownerFund)) return "fund";

    return scope.includes(accounts.ownerPersonal) ? "personal" : null;
  }

  const text = await band(page).innerText();
  const at = text.indexOf(name);
  if (at < 0) return null;

  const bands = [
    [accounts.ownerPersonal, "personal"],
    [fundBand, "fund"],
  ] as const;

  return (
    bands
      .map(([label, placement]) => ({ placement, at: text.lastIndexOf(label, at) }))
      .filter((one) => one.at >= 0)
      .sort((a, b) => a.at - b.at)
      .at(-1)?.placement ?? null
  );
}

/**
 * Moves the list to one of its two tabs. The phone segments the states into a
 * control of its own; the laptop keeps them in the filter bar's select, and only
 * one of the pair is ever displayed.
 */
async function showTab(page: Page, label: string): Promise<void> {
  const segment = page.getByRole("radio", { name: label, exact: true });
  if ((await segment.count()) > 0) {
    await segment.click();
    return;
  }

  await page.getByRole("combobox", { name: accounts.statusLabel }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/** Runs a row's menu item through the confirmation it raises. */
async function confirmThroughMenu(
  page: Page,
  name: string,
  menuItem: string,
  confirmLabel: string,
): Promise<Locator> {
  await rowMenu(page, name).click();
  await page.getByRole("menuitem", { name: menuItem, exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();

  return dialog;
}

/**
 * One personal account of the harness user, optionally carrying one movement out
 * of it. Written as the owner while speaking for that user, which is what the
 * stamping triggers read.
 */
async function seedAccount(options: {
  openingCents: number;
  movementCents?: number;
}): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = `Cuenta ${stamp}-${(serial += 1)}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype,
        initial_balance_cents, initial_balance_on)
      values (
        ${id}, ${scope.userId}, ${name}, 'asset', 'bancaria',
        ${options.openingCents}, (now() at time zone ${TIME_ZONE})::date)`;

    if (options.movementCents === undefined) return;

    const [movement] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (
        ${id}, ${options.movementCents}, (now() at time zone ${TIME_ZONE})::date,
        ${`Movimiento ${stamp}`})
      returning id`;
    // An expense carries at least one split, and the trigger that keeps it that
    // way fires on the movement, not on the screen.
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${movement.id}, ${scope.categoryId}, ${options.movementCents})`;
  });

  return { id, name };
}

// Written through the interface or seeded outside the tracked ids, so each test
// drops its own. The movements go first: the foreign key restricts.
async function dropAccount(accountId: string): Promise<void> {
  await fixtureSql`
    delete from transactions
    where from_account_id = ${accountId} or to_account_id = ${accountId}`;
  await fixtureSql`delete from accounts where id = ${accountId}`;
}

test("creates an account from the form and stores its opening balance signed by its kind", async ({
  page,
}) => {
  // A liability, so the sign is a decision and not the identity: an opening debt
  // is stored negative, which is what keeps net worth a plain sum (RNF-05).
  const name = `Tarjeta ${Date.now()}`;
  const owedPesos = "250000";
  const owedCents = -25000000;

  await page.goto("/es/settings/accounts");
  await page.getByRole("button", { name: accounts.add, exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("textbox", { name: accounts.nameLabel }).fill(name);
  await dialog
    .getByRole("radio", { name: accounts.kindLiability, exact: true })
    .click();
  await dialog
    .getByRole("radio", { name: accounts.subtypeTarjeta, exact: true })
    .click();
  // The amount field renames itself with the kind, so this also proves the
  // toggle above landed.
  await dialog
    .getByRole("textbox", { name: accounts.openingOwedLabel })
    .fill(owedPesos);

  await dialog.getByRole("button", { name: messages.common.save }).click();

  await expect(dialog).toBeHidden();
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  const rows = await fixtureSql<
    { id: string; kind: string; subtype: string; initial_balance_cents: string }[]
  >`
    select id, kind, subtype, initial_balance_cents::text as initial_balance_cents
    from accounts
    where owner_user_id = ${scope.userId} and name = ${name}`;

  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("liability");
  expect(rows[0].subtype).toBe("tarjeta");
  expect(rows[0].initial_balance_cents).toBe(String(owedCents));

  // Written through the interface, so it carries no fixture id: dropped here
  // rather than by the tracked cleanup.
  await fixtureSql`delete from accounts where id = ${rows[0].id}`;
});

test.describe("the phone's card", () => {
  // The two figures below are two labelled lines of the card, and both projects
  // drive them at the width that draws it: the laptop's table gives the balance a
  // column of its own and states no opening figure anywhere, so the pair is only
  // ever readable off the card (SPEC-A3, RNF-08).
  test.use({ viewport: { width: 360, height: 740 } });

  test("draws the balance its movements derive and not the figure it opened with", async ({
    page,
  }) => {
    const openingCents = 1_000_000;
    const movementCents = 250_000;
    const account = await seedAccount({ openingCents, movementCents });

    await page.goto("/es/settings/accounts");

    // The view is where the balance comes from (RF-114): the card is read against
    // it, never against a figure this test computed on its own.
    const [derived] = await fixtureSql<{ balance_cents: string }[]>`
      select balance_cents::text as balance_cents
      from account_balances where id = ${account.id}`;
    expect(Number(derived.balance_cents)).toBe(openingCents - movementCents);

    const subject = card(page, account.name);
    const shown = pesosOf(await line(subject, accounts.balanceLabel).innerText());
    expect(shown).toBe(Number(derived.balance_cents) / 100);

    // And the opening figure is still on the same card, still saying what it said:
    // a screen that drew one figure twice would agree with itself and be wrong.
    const opening = await line(subject, accounts.openingBalanceLabel).innerText();
    expect(pesosOf(opening.split(OPENING_SEPARATOR)[0])).toBe(openingCents / 100);
    expect(shown).not.toBe(openingCents / 100);

    await dropAccount(account.id);
  });

  // D4: a balance drawn with `tone="plain"` has no tone to carry the sign, so
  // an overdraft used to lose it and read as a positive figure.
  test("draws the minus when the derived balance is negative", async ({ page }) => {
    const openingCents = 200_000;
    const movementCents = 500_000;
    const account = await seedAccount({ openingCents, movementCents });

    await page.goto("/es/settings/accounts");

    const [derived] = await fixtureSql<{ balance_cents: string }[]>`
      select balance_cents::text as balance_cents
      from account_balances where id = ${account.id}`;
    expect(Number(derived.balance_cents)).toBeLessThan(0);

    const shown = await line(card(page, account.name), accounts.balanceLabel).innerText();
    expect(shown).toContain(MINUS);
    expect(pesosOf(shown)).toBe(Math.abs(Number(derived.balance_cents)) / 100);

    await dropAccount(account.id);
  });

  test("shows a second currency under the settlement figure, itself unmoved by the estimate", async ({
    page,
  }) => {
    const openingCents = 300_000;
    const account = await seedAccount({ openingCents });
    // A dollar purchase against this peso account, still an estimate (RF-121,
    // RF-123): it opens a pocket of its own and never touches the settlement one.
    const usdCents = 8_000;
    const copEstimateCents = 3_200_000;

    await asHarnessUser(async (tx) => {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (
          from_account_id, amount_cents, occurred_at, description,
          currency, counter_amount_cents, counter_is_estimate)
        values (
          ${account.id}, ${usdCents}, (now() at time zone ${TIME_ZONE})::date,
          'Compra en dólares', 'USD', ${copEstimateCents}, true)
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, ${usdCents})`;
    });

    await page.goto("/es/settings/accounts");

    const [foreignPocket] = await fixtureSql<{ balance_cents: string }[]>`
      select balance_cents::text as balance_cents
      from account_balances where id = ${account.id} and currency = 'USD'`;
    expect(Number(foreignPocket.balance_cents)).toBe(-usdCents);

    const subject = card(page, account.name);
    const settlementShown = pesosOf(
      await line(subject, accounts.balanceLabel).innerText(),
    );
    expect(settlementShown).toBe(openingCents / 100);

    // USD is written with two decimals, the same scale the column already
    // stores every currency in (RNF-05), so its digits are the stored cents
    // directly — no division by 100 as `pesosOf` does for a peso figure.
    const otherLine = subject.getByText(otherCurrencyLabel("USD"), { exact: false });
    await expect(otherLine).toBeVisible();
    const otherText = await otherLine.innerText();
    expect(otherText).toContain(MINUS);
    expect(Number(otherText.replace(/\D/g, ""))).toBe(usdCents);

    await dropAccount(account.id);
  });
});

test.describe("the laptop row", () => {
  // The dense table renders from `lg` up, and both projects drive it at the
  // width the artboard states rather than skipping one of them (SPEC-A3,
  // RNF-08).
  test.use({ viewport: { width: 1280, height: 900 } });

  test("states the derived balance in the cell under its own column", async ({
    page,
  }) => {
    const openingCents = 1_000_000;
    const movementCents = 250_000;
    const account = await seedAccount({ openingCents, movementCents });

    await page.goto("/es/settings/accounts");

    // The view is where the balance comes from (RF-114): the cell is read
    // against it, never against a figure this test computed on its own.
    const [derived] = await fixtureSql<{ balance_cents: string }[]>`
      select balance_cents::text as balance_cents
      from account_balances where id = ${account.id}`;
    expect(Number(derived.balance_cents)).toBe(openingCents - movementCents);

    // The fifth of the six tracks, after the name, the entity, the last four
    // digits and the class.
    const cell = page
      .getByRole("table", { name: accounts.title })
      .getByRole("row")
      .filter({ hasText: account.name })
      .getByRole("cell")
      .nth(4);
    await expect(cell).toBeVisible();

    // The table states no opening figure, so what says the column is derived is
    // that it is not the one the account was written with.
    const shown = pesosOf(await cell.innerText());
    expect(shown).toBe(Number(derived.balance_cents) / 100);
    expect(shown).not.toBe(openingCents / 100);

    await dropAccount(account.id);
  });

  // D4: the fifth cell also draws through `Money` with `tone="plain"`, the same
  // tone that lost the sign on the phone's card.
  test("draws the minus when the derived balance is negative", async ({ page }) => {
    const openingCents = 200_000;
    const movementCents = 500_000;
    const account = await seedAccount({ openingCents, movementCents });

    await page.goto("/es/settings/accounts");

    const [derived] = await fixtureSql<{ balance_cents: string }[]>`
      select balance_cents::text as balance_cents
      from account_balances where id = ${account.id}`;
    expect(Number(derived.balance_cents)).toBeLessThan(0);

    const cell = page
      .getByRole("table", { name: accounts.title })
      .getByRole("row")
      .filter({ hasText: account.name })
      .getByRole("cell")
      .nth(4);
    await expect(cell).toBeVisible();

    const shown = await cell.innerText();
    expect(shown).toContain(MINUS);
    expect(pesosOf(shown)).toBe(Math.abs(Number(derived.balance_cents)) / 100);

    await dropAccount(account.id);
  });

  test("draws a second currency in the same cell, apart from the settlement figure", async ({
    page,
  }) => {
    const openingCents = 300_000;
    const account = await seedAccount({ openingCents });
    const usdCents = 8_000;
    const copEstimateCents = 3_200_000;

    await asHarnessUser(async (tx) => {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (
          from_account_id, amount_cents, occurred_at, description,
          currency, counter_amount_cents, counter_is_estimate)
        values (
          ${account.id}, ${usdCents}, (now() at time zone ${TIME_ZONE})::date,
          'Compra en dólares', 'USD', ${copEstimateCents}, true)
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, ${usdCents})`;
    });

    await page.goto("/es/settings/accounts");

    const cell = page
      .getByRole("table", { name: accounts.title })
      .getByRole("row")
      .filter({ hasText: account.name })
      .getByRole("cell")
      .nth(4);
    await expect(cell).toBeVisible();

    // The cell's own second line, read in isolation first: the column stores no
    // per-row label to scope by here, so the settlement figure below is read as
    // whatever the cell states beyond this substring, not by DOM position.
    const otherLine = cell.getByText(otherCurrencyLabel("USD"), { exact: false });
    await expect(otherLine).toBeVisible();
    const otherText = await otherLine.innerText();
    expect(otherText).toContain(MINUS);
    expect(Number(otherText.replace(/\D/g, ""))).toBe(usdCents);

    const settlementOnly = (await cell.innerText()).replace(otherText, "").trim();
    expect(pesosOf(settlementOnly)).toBe(openingCents / 100);

    await dropAccount(account.id);
  });
});

test("saves the name and the opening date the edit dialog was given", async ({
  page,
}) => {
  const account = await seedAccount({ openingCents: 500_000 });
  const renamed = `Cuenta renombrada ${stamp}`;
  // In the past: the form refuses a future opening date.
  const openedOn = "2025-03-04";

  await page.goto("/es/settings/accounts");
  await rowMenu(page, account.name).click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();

  // Prefilled from the row, which is what says the dialog opened on this account.
  const dialog = page.getByRole("dialog");
  const nameField = dialog.getByRole("textbox", { name: accounts.nameLabel });
  await expect(nameField).toHaveValue(account.name);

  await nameField.fill(renamed);
  await dialog.getByLabel(accounts.openingBalanceOnLabel).fill(openedOn);
  await dialog.getByRole("button", { name: common.save, exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(band(page).getByText(renamed, { exact: true })).toBeVisible();

  const [saved] = await fixtureSql<{ name: string; initial_balance_on: string }[]>`
    select name, initial_balance_on::text as initial_balance_on
    from accounts where id = ${account.id}`;
  expect(saved.name).toBe(renamed);
  expect(saved.initial_balance_on).toBe(openedOn);

  await dropAccount(account.id);
});

test("refuses to delete an account carrying a movement, and archives it instead", async ({
  page,
}) => {
  const account = await seedAccount({ openingCents: 800_000, movementCents: 100_000 });

  await page.goto("/es/settings/accounts");
  const dialog = await confirmThroughMenu(
    page,
    account.name,
    common.delete,
    common.delete,
  );

  // RF-11: the refusal is copy a person can act on, and its own sentence — the
  // hand-over's refusal is a different attempt, and the vanished-reference
  // sentence is a different failure entirely.
  await expect(
    page.getByText(errors.accountHasMovements, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(errors.accountHasHistory, { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(errors.referenceGone, { exact: true })).toHaveCount(0);

  // A refused confirmation stays open, which is what keeps the list under an
  // `aria-hidden` a role locator would not reach.
  await dialog.getByRole("button", { name: common.cancel, exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(band(page).getByText(account.name, { exact: true })).toBeVisible();
  expect(
    await fixtureSql`select id from accounts where id = ${account.id}`,
  ).toHaveLength(1);

  // Archiving is the way out the refusal names, and it is on the same menu.
  const archiving = await confirmThroughMenu(
    page,
    account.name,
    common.archive,
    common.archive,
  );
  await expect(archiving).toBeHidden();
  await expect(band(page).getByText(account.name, { exact: true })).toHaveCount(0);

  await showTab(page, accounts.archivedTab);
  await expect(band(page).getByText(account.name, { exact: true })).toBeVisible();

  const [archived] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from accounts where id = ${account.id}`;
  expect(archived.archived_at).not.toBeNull();

  await dropAccount(account.id);
});

test("deletes an account that carries nothing, from that same confirmation", async ({
  page,
}) => {
  // The other half of RF-60's D: the refusal above only means something if the
  // delete lands when there is nothing to keep.
  const account = await seedAccount({ openingCents: 200_000 });

  await page.goto("/es/settings/accounts");
  const dialog = await confirmThroughMenu(
    page,
    account.name,
    common.delete,
    common.delete,
  );

  await expect(page.getByText(accounts.deleted, { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(band(page).getByText(account.name, { exact: true })).toHaveCount(0);

  // Gone, not archived: nothing derived from it, so nothing had to be kept.
  expect(
    await fixtureSql`select id from accounts where id = ${account.id}`,
  ).toHaveLength(0);
});

test.describe("with a fund behind the caller", () => {
  let groupId = "";
  let fundName = "";

  test.beforeEach(async () => {
    ({ groupId } = await seedGroup());
    const [group] = await fixtureSql<{ name: string }[]>`
      select name from groups where id = ${groupId}`;
    fundName = group.name;
  });

  // The group is this describe's alone: one left behind moves every other
  // screen's scope from personal to the fund's.
  test.afterAll(async () => {
    await clearGroup();
  });

  test("creates the account on the group when the form is told to", async ({
    page,
  }) => {
    const name = `Cuenta del fondo ${stamp}`;

    await page.goto("/es/settings/accounts");
    await page.getByRole("button", { name: accounts.add, exact: true }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: accounts.nameLabel }).fill(name);
    await dialog.getByRole("combobox", { name: accounts.ownerLabel }).click();
    // The option list is portalled out of the dialog.
    await page.getByRole("option", { name: accounts.ownerFund, exact: true }).click();
    await dialog
      .getByRole("textbox", { name: accounts.openingBalanceLabel })
      .fill("40000");
    await dialog.getByRole("button", { name: common.save, exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(band(page).getByText(name, { exact: true })).toBeVisible();

    // The placement is resolved from the session, so the row is what says where
    // it landed: a group account names its group, no owner, and is shared.
    const [created] = await fixtureSql<
      {
        id: string;
        owner_user_id: string | null;
        group_id: string | null;
        is_shared: boolean;
      }[]
    >`
      select id, owner_user_id, group_id, is_shared from accounts
      where group_id = ${groupId} and name = ${name}`;
    expect(created.owner_user_id).toBeNull();
    expect(created.group_id).toBe(groupId);
    expect(created.is_shared).toBe(true);

    await expect.poll(async () => await placementOf(page, name, fundName)).toBe("fund");

    await dropAccount(created.id);
  });

  test("refuses to hand over an account carrying a movement, and names that attempt", async ({
    page,
  }) => {
    const account = await seedAccount({ openingCents: 600_000, movementCents: 50_000 });

    await page.goto("/es/settings/accounts");
    const dialog = await confirmThroughMenu(
      page,
      account.name,
      accounts.handOver,
      accounts.handOver,
    );

    // Its own sentence, not the one a refused delete raises: re-scoping a
    // movement would re-scope its splits, so this account is archived instead.
    await expect(
      page.getByText(errors.accountHasHistory, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(errors.accountHasMovements, { exact: true }),
    ).toHaveCount(0);

    await dialog.getByRole("button", { name: common.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();

    // And the row still names the person it belongs to.
    const [refused] = await fixtureSql<
      { owner_user_id: string | null; group_id: string | null }[]
    >`
      select owner_user_id, group_id from accounts where id = ${account.id}`;
    expect(refused.owner_user_id).toBe(scope.userId);
    expect(refused.group_id).toBeNull();

    await dropAccount(account.id);
  });

  test("hands a history-free personal account to the group from its row menu", async ({
    page,
  }) => {
    const account = await seedAccount({ openingCents: 300_000 });

    await page.goto("/es/settings/accounts");
    // `goto` resolves before the list streams in, and the read is a snapshot.
    await expect
      .poll(async () => await placementOf(page, account.name, fundName))
      .toBe("personal");

    const dialog = await confirmThroughMenu(
      page,
      account.name,
      accounts.handOver,
      accounts.handOver,
    );
    await expect(page.getByText(accounts.handedOver, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();

    // The account changes sides, which is the only thing on screen that says it
    // stopped being one person's (RF-61).
    await expect
      .poll(async () => await placementOf(page, account.name, fundName))
      .toBe("fund");

    const [handed] = await fixtureSql<
      { owner_user_id: string | null; group_id: string | null; is_shared: boolean }[]
    >`
      select owner_user_id, group_id, is_shared from accounts where id = ${account.id}`;
    expect(handed.owner_user_id).toBeNull();
    expect(handed.group_id).toBe(groupId);
    expect(handed.is_shared).toBe(true);

    // And the row it landed on has nowhere further to go.
    await rowMenu(page, account.name).click();
    await expect(
      page.getByRole("menu").getByRole("menuitem", { name: accounts.handOver }),
    ).toHaveCount(0);

    await dropAccount(account.id);
  });
});
