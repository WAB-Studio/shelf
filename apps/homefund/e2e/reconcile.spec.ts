/**
 * RF-137 from the screen: a person opens «Cuadrar» on an account's row, reads
 * what HomeFund derives for a day, types what they counted, reads the gap,
 * confirms, and reads the account's reconciliations in the same dialog.
 *
 * Written from boards B1-B8, before the dialog
 * exists. Every figure a test expects is stated here from the rows it seeds
 * (opening + legs), never read back from the screen it judges; what the
 * database holds afterwards is read with the fixture connection.
 *
 * The seeded account opens 30 days ago and spends once, 10 days ago, so
 * HomeFund derives $ 500.000 before that day and $ 480.000 from it on.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  readScope,
  test,
} from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
let serial = 0;

// `Money`'s own sign, U+2212, never the hyphen a keyboard types.
const MINUS = "−";

const TODAY = todayInBogota();
// The date field reads day first in Spanish, whatever civil date it holds underneath.
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const OPENED = addCivilDays(TODAY, -30);
const SPENT = addCivilDays(TODAY, -10);

const OPENING = 50_000_000; // $ 500.000 in hundredths
const SPEND = 2_000_000; // $ 20.000
const DERIVED_TODAY = OPENING - SPEND; // $ 500.000

// Pesos as the screen writes them: a dot between thousands, no decimals.
function peso(pesos: number): string {
  return `$ ${Math.abs(pesos).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function signed(pesos: number): string {
  if (pesos === 0) return peso(0);
  return `${pesos < 0 ? MINUS : "+"}${peso(pesos)}`;
}

// Intl separates the symbol from the figure with a no-break space.
function flat(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

type Seeded = { id: string; name: string };

async function seedAccount(
  options: {
    kind?: "asset" | "liability";
    subtype?: string;
    openingCents?: number;
    spendCents?: number;
    archived?: boolean;
    currency?: string;
  } = {},
): Promise<Seeded> {
  const id = randomUUID();
  const kind = options.kind ?? "asset";
  const name = `Cuadre ${stamp}-${(serial += 1)}`;
  const opening = options.openingCents ?? OPENING;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on,
        settlement_currency)
      values (
        ${id}, ${scope.userId}, ${name}, ${kind},
        ${options.subtype ?? (kind === "asset" ? "bank" : "card")},
        ${opening}, ${OPENED}, ${options.currency ?? "COP"})`;

    const spend = options.spendCents ?? (kind === "asset" ? SPEND : 0);
    if (spend > 0) {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${id}, ${spend}, ${SPENT}, ${`Gasto ${stamp}`})
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, ${spend})`;
    }

    if (options.archived) {
      await tx`update accounts set archived_at = now() where id = ${id}`;
    }
  });

  return { id, name };
}

// The database books the adjustment itself; a fixture only records the count.
async function seedReconciliation(
  accountId: string,
  on: string,
  countedCents: number,
): Promise<void> {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
      values (${accountId}, ${on}, ${countedCents})`;
  });
}

async function dropAccount(accountId: string): Promise<void> {
  await fixtureSql`
    delete from transactions where from_account_id = ${accountId} or to_account_id = ${accountId}`;
  await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
  await fixtureSql`delete from accounts where id = ${accountId}`;
}

async function reconciliationsOf(accountId: string) {
  return fixtureSql<
    { reconciled_on: string; counted: string }[]
  >`
    select reconciled_on::text, counted_balance_cents::text as counted
    from account_reconciliations where account_id = ${accountId}
    order by reconciled_on, created_at`;
}

async function adjustmentsOf(accountId: string) {
  return fixtureSql<{ amount: string; to_me: boolean; on: string }[]>`
    select amount_cents::text as amount, (to_account_id = ${accountId}) as to_me, occurred_at::text as "on"
    from transactions
    where reconciliation_id is not null
      and (from_account_id = ${accountId} or to_account_id = ${accountId})`;
}

function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

// Both bands stay in the DOM and CSS displays one; the row or card is whatever
// is displayed and names the account.
function listed(page: Page, name: string): Locator {
  const row = page.getByRole("row").filter({ hasText: name }).filter({ visible: true });
  const card = page
    .locator("main > div > .rt-Box")
    .filter({ visible: true })
    .locator("div")
    .filter({ has: rowMenu(page, name) })
    .filter({ hasText: name })
    .last();

  return row.or(card).first();
}

async function openDialog(page: Page, account: Seeded): Promise<Locator> {
  await page.goto("/es/settings/accounts");
  await rowMenu(page, account.name).click();
  await page.getByRole("menuitem", { name: accounts.reconcile, exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(accounts.reconcileTitle.replace("{name}", account.name), { exact: true }),
  ).toBeVisible();
  // The sheet is read on open: the derived figure is the gate every test waits on.
  await expect(dialog.getByText(accounts.reconcileDerived, { exact: true })).toBeVisible();

  return dialog;
}

// A labelled line of the dialog: the label and the figure beside it.
function line(dialog: Locator, label: string): Locator {
  return dialog.getByText(label, { exact: true }).locator("..");
}

function realField(dialog: Locator, label = accounts.reconcileRealAsset): Locator {
  return dialog.getByRole("textbox", { name: label, exact: true });
}

function dayField(dialog: Locator): Locator {
  return dialog.getByLabel(accounts.reconcileDay, { exact: true });
}

function submit(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: accounts.reconcileSubmit, exact: true });
}

// The history's figures lines, newest first. Their text is the board's B7 line
// two; the «Según HomeFund» label of the sheet above is a different element.
function historyFigures(dialog: Locator): Locator {
  return dialog.getByText(/^Según HomeFund .+ · Real .+$/);
}

// A history figure as the person types it, with the glyph `Money` writes below zero.
function figure(pesos: number): string {
  return `${pesos < 0 ? MINUS : ""}${peso(pesos)}`;
}

function figuresText(derived: number, real: number): string {
  return accounts.reconciliationFigures
    .replace("{derived}", figure(derived))
    .replace("{real}", figure(real));
}

const hintAsset = accounts.reconcileRealHintAsset;

function hint(dialog: Locator, text: string): Locator {
  return dialog.getByText(text, { exact: true });
}

test.describe("the row menu (B8)", () => {
  test("offers Cuadrar between Editar and Archivar on a live account the caller writes", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      await page.goto("/es/settings/accounts");
      await rowMenu(page, account.name).click();

      await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
        common.edit,
        accounts.reconcile,
        common.archive,
        common.delete,
      ]);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("the dialog's states", () => {
  test("opens empty (B1): title, currency, today, the derived figure, no Descuadre line", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);

      await expect(
        dialog.getByText(accounts.reconcileCurrency.replace("{currency}", "COP"), { exact: true }),
      ).toBeVisible();
      await expect(dayField(dialog)).toHaveValue(dmy(TODAY));
      expect(flat(await line(dialog, accounts.reconcileDerived).innerText())).toContain(
        peso(DERIVED_TODAY / 100),
      );
      await expect(realField(dialog)).toHaveValue("");
      await expect(dialog.getByText(accounts.reconcileGap, { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: common.cancel, exact: true })).toBeEnabled();
      await expect(submit(dialog)).toBeEnabled();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("shows a positive gap with its sign and the day it will be booked (B2)", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill(String(DERIVED_TODAY / 100 + 12_000));

      const gap = line(dialog, accounts.reconcileGap);
      await expect(gap).toContainText(signed(12_000));
      expect(flat(await gap.innerText())).not.toContain(MINUS);

      const hintPrefix = accounts.reconcileGapHint.split("{date}")[0];
      const hint = dialog.getByText(hintPrefix, { exact: false });
      await expect(hint).toBeVisible();
      // «del 14 oct.»: a day and a month, the day being the chosen one.
      const day = String(Number(TODAY.slice(8)));
      expect(flat(await hint.innerText())).toMatch(new RegExp(`${hintPrefix}${day} \\p{L}{3,4}\\.?$`, "u"));
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("confirming (B7)", () => {
  test("books the gap, toasts, keeps the dialog open on the fresh history, and moves the listed balance", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await expect(dialog.getByText(accounts.reconciliationsEmpty, { exact: true })).toBeVisible();

      const url = page.url();
      await realField(dialog).fill(String(DERIVED_TODAY / 100 + 12_000));
      await submit(dialog).click();

      await expect(page.getByText(accounts.reconciled, { exact: true })).toBeVisible();
      await expect(dialog).toBeVisible();
      expect(page.url()).toBe(url);

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe(
        figuresText(DERIVED_TODAY / 100, DERIVED_TODAY / 100 + 12_000),
      );
      const row = first.locator("..");
      expect(flat(await row.innerText())).toContain(signed(12_000));
      expect(flat(await row.innerText())).toContain(String(TODAY.slice(0, 4)));
      await expect(dialog.getByText(accounts.reconciliationsEmpty, { exact: true })).toHaveCount(0);
      // The history stays inside the dialog.
      await expect(dialog.getByRole("link")).toHaveCount(0);

      expect(await reconciliationsOf(account.id)).toEqual([
        { reconciled_on: TODAY, counted: String(DERIVED_TODAY + 1_200_000) },
      ]);
      expect(await adjustmentsOf(account.id)).toEqual([
        { amount: "1200000", to_me: true, on: TODAY },
      ]);

      // No reload: the list behind the dialog has to have been revalidated.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      const listedText = flat(await listed(page, account.name).innerText());
      expect(listedText).toContain(peso(DERIVED_TODAY / 100 + 12_000));
      expect(listedText).not.toContain(peso(DERIVED_TODAY / 100));
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a figure at zero gap reads Cuadró and books no movement", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill(String(DERIVED_TODAY / 100));
      await submit(dialog).click();

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      await expect(first.locator("..")).toContainText(accounts.reconciliationBalanced);

      expect(await reconciliationsOf(account.id)).toHaveLength(1);
      expect(await adjustmentsOf(account.id)).toHaveLength(0);

      await page.goto("/es/movements");
      // The laptop's table prints the description; the phone's card prints category and account.
      const spent = page
        .getByText(`Gasto ${stamp}`)
        .or(page.getByRole("link", { name: account.name }))
        .filter({ visible: true });
      await expect(spent.first()).toBeVisible();
      // Scoped to the movement rows (the laptop's table rows, the phone's card links): the type filter also offers «Descuadre».
      await expect(
        page
          .getByRole("row")
          .or(page.locator('a[href*="/movements/"]'))
          .getByText("Diferencia", { exact: true }),
      ).toHaveCount(0);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("the history", () => {
  test("lists the reconciliations newest first", async ({ page }) => {
    const account = await seedAccount();
    try {
      // 6 days ago: counts $ 485.000 against $ 480.000; 3 days ago: counts the
      // $ 480.000 back against the $ 485.000 the first one made true.
      await seedReconciliation(account.id, addCivilDays(TODAY, -6), 48_500_000);
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 48_000_000);

      const dialog = await openDialog(page, account);
      const figures = historyFigures(dialog);
      await expect(figures).toHaveCount(2);

      expect(flat(await figures.nth(0).innerText())).toBe(figuresText(485_000, 480_000));
      expect(flat(await figures.nth(0).locator("..").innerText())).toContain(signed(-5_000));
      expect(flat(await figures.nth(1).innerText())).toBe(figuresText(480_000, 485_000));
      expect(flat(await figures.nth(1).locator("..").innerText())).toContain(signed(5_000));
      await expect(dialog.getByText(accounts.reconciliationsEmpty, { exact: true })).toHaveCount(0);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("at 360 px", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test("overflows nowhere and keeps every control at least 44 px on its short side, the hint drawn @mobile", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 48_500_000);
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("492000");
      await expect(line(dialog, accounts.reconcileGap)).toBeVisible();
      await expect(historyFigures(dialog)).toHaveCount(1);
      await expect(hint(dialog, hintAsset)).toBeVisible();
      // Radix scales the dialog in; a box read mid-animation is smaller than the settled one.
      await expect
        .poll(() =>
          dialog.evaluate((el) => el.getAnimations().every((animation) => animation.playState === "finished")),
        )
        .toBe(true);

      const overflow = await page.evaluate(() => {
        const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
        const dialogEl = document.querySelector('[role="dialog"]');
        return {
          page: document.documentElement.scrollWidth > window.innerWidth,
          dialog: dialogEl ? wide(dialogEl) : null,
        };
      });
      expect(overflow).toEqual({ page: false, dialog: false });

      const controls = dialog.locator("button:visible, input:visible");
      const count = await controls.count();
      expect(count).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < count; i += 1) {
        const box = await controls.nth(i).boundingBox();
        const label = await controls.nth(i).evaluate((el) => el.outerHTML.slice(0, 80));
        expect(box, label).not.toBeNull();
        expect(Math.min(box!.width, box!.height), label).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await dropAccount(account.id);
    }
  });
});
