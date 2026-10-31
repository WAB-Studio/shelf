/**
 * RF-137 from the screen: a person opens «Cuadrar» on an account's row, reads
 * what HomeFund derives for a day, types what they counted, reads the gap,
 * confirms, and reads the account's reconciliations in the same dialog.
 *
 * Written from the plan's M3 Done table and boards B1-B8, before the dialog
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
  MEMBER_STORAGE_STATE,
  STORAGE_STATE,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;
const errors = messages.errors;
const amountInvalid = messages.transactions.errors.amountInvalid;

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
const DERIVED_TODAY = OPENING - SPEND; // $ 480.000
const DERIVED_BEFORE_SPEND = OPENING; // $ 500.000

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

// Line 3 of the sheet, flattened: the label and the figure beside it, as one reads them.
async function derivedLine(dialog: Locator): Promise<string> {
  return flat(await line(dialog, accounts.reconcileDerived).innerText());
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
const hintLiability = accounts.reconcileRealHintLiability;

function hint(dialog: Locator, text: string): Locator {
  return dialog.getByText(text, { exact: true });
}

// Server actions are POSTs carrying `next-action`; the counter says whether the
// screen asked the server for anything.
function countServerActions(page: Page): { count: () => number; reset: () => void } {
  let n = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"] !== undefined) n += 1;
  });

  return { count: () => n, reset: () => (n = 0) };
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

  test("offers no Cuadrar on an archived account, while its live neighbour has it", async ({
    page,
  }) => {
    const live = await seedAccount();
    const archived = await seedAccount({ archived: true });
    try {
      await page.goto("/es/settings/accounts");
      await rowMenu(page, live.name).click();
      await expect(page.getByRole("menuitem", { name: accounts.reconcile, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      const segment = page.getByRole("radio", { name: accounts.archivedTab, exact: true });
      const statusSelect = page.getByRole("combobox", { name: accounts.statusLabel });
      // count() does not wait: let whichever of the pair is displayed render first.
      await expect(segment.or(statusSelect)).toBeVisible();
      if ((await segment.count()) > 0) {
        await segment.click();
      } else {
        await statusSelect.click();
        await page.getByRole("option", { name: accounts.archivedTab, exact: true }).click();
      }

      await rowMenu(page, archived.name).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByRole("menuitem", { name: accounts.reconcile })).toHaveCount(0);
    } finally {
      await dropAccount(live.id);
      await dropAccount(archived.id);
    }
  });

  test.describe("for a plain member reading another member's account", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });
    let account: Seeded;

    test.beforeAll(async () => {
      await seedGroup();
      account = await seedAccount();
    });

    test.afterAll(async () => {
      await dropAccount(account.id);
      await clearGroup();
    });

    test("offers no Cuadrar, where its owner is offered it", async ({ page, browser, baseURL }) => {
      // The owner's menu on the same row is the control: without it, an account the
      // member cannot see at all would pass for the wrong reason.
      const ownerContext = await browser.newContext({ baseURL, storageState: STORAGE_STATE });
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto("/es/settings/accounts");
      await rowMenu(ownerPage, account.name).click();
      await expect(
        ownerPage.getByRole("menuitem", { name: accounts.reconcile, exact: true }),
      ).toBeVisible();
      await ownerContext.close();

      await page.goto("/es/settings/accounts");
      await rowMenu(page, account.name).click();
      await expect(page.getByRole("menuitem", { name: common.edit, exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: accounts.reconcile })).toHaveCount(0);
    });

    // The phone draws accounts as cards, a sibling of the laptop's table that decides
    // «Cuadrar» on its own; the laptop project reaches it by narrowing the window.
    test("offers no Cuadrar on the phone's card, where its owner is offered it", async ({
      page,
      browser,
      baseURL,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the mobile project is already narrow");
      const phone = { width: 390, height: 844 };

      const ownerContext = await browser.newContext({
        baseURL,
        storageState: STORAGE_STATE,
        viewport: phone,
      });
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto("/es/settings/accounts");
      await rowMenu(ownerPage, account.name).click();
      await expect(
        ownerPage.getByRole("menuitem", { name: accounts.reconcile, exact: true }),
      ).toBeVisible();
      await ownerContext.close();

      await page.setViewportSize(phone);
      await page.goto("/es/settings/accounts");
      await rowMenu(page, account.name).click();
      await expect(page.getByRole("menuitem", { name: common.edit, exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: accounts.reconcile })).toHaveCount(0);
    });
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

  test("re-reads the derived figure when the day changes", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      const derived = line(dialog, accounts.reconcileDerived);
      expect(flat(await derived.innerText())).toContain(peso(DERIVED_TODAY / 100));

      await dayField(dialog).fill(addCivilDays(SPENT, -1));
      await expect(derived).toContainText(peso(DERIVED_BEFORE_SPEND / 100));
      expect(flat(await derived.innerText())).not.toContain(peso(DERIVED_TODAY / 100));

      await dayField(dialog).fill(TODAY);
      await expect(derived).toContainText(peso(DERIVED_TODAY / 100));
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

  test("shows a negative gap with the minus (B3)", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill(String(DERIVED_TODAY / 100 - 8_000));

      // Kills: the magnitude not taken before the minus is prefixed (a doubled sign still «contains» the figure).
      await expect(
        line(dialog, accounts.reconcileGap).locator("span").filter({ hasText: peso(8_000) }).last(),
      ).toHaveText(signed(-8_000));
      await expect(
        dialog.getByText(accounts.reconcileGapHint.split("{date}")[0], { exact: false }),
      ).toBeVisible();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("shows a zero gap and says nothing is booked (B4)", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill(String(DERIVED_TODAY / 100));

      const gap = line(dialog, accounts.reconcileGap);
      await expect(gap).toContainText(peso(0));
      expect(flat(await gap.innerText())).not.toMatch(/[+−]/);
      await expect(dialog.getByText(accounts.reconcileBalanced, { exact: true })).toBeVisible();
      await expect(
        dialog.getByText(accounts.reconcileGapHint.split("{date}")[0], { exact: false }),
      ).toHaveCount(0);
      await expect(submit(dialog)).toBeEnabled();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a liability asks for the real debt and signs it by its kind", async ({ page }) => {
    const owed = 12_000_000; // $ 120.000
    const account = await seedAccount({ kind: "liability", openingCents: -owed });
    try {
      const dialog = await openDialog(page, account);

      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} ${peso(owed / 100)}`);
      await expect(dialog.getByText(accounts.reconcileRealAsset, { exact: true })).toHaveCount(0);

      // Typing the debt as a magnitude: owing $ 100.000 instead of $ 120.000
      // is a gap of −$ 20.000 in the field's frame, not of $ 220.000.
      await realField(dialog, accounts.reconcileRealLiability).fill("100000");
      await expect(line(dialog, accounts.reconcileGap)).toContainText(signed(-20_000));

      await submit(dialog).click();
      await expect(dialog.getByText(accounts.reconciled).or(historyFigures(dialog))).toBeVisible();

      const rows = await reconciliationsOf(account.id);
      expect(rows.map((r) => r.counted)).toEqual(["-10000000"]);
      const adjustments = await adjustmentsOf(account.id);
      expect(adjustments).toEqual([{ amount: "2000000", to_me: true, on: TODAY }]);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("refusals (B5b)", () => {
  test("refuses a silent submit without asking the server", async ({ page }) => {
    const account = await seedAccount();
    const actions = countServerActions(page);
    try {
      const dialog = await openDialog(page, account);
      actions.reset();

      await submit(dialog).click();

      await expect(dialog.getByText(errors.reconcileRealRequired, { exact: true })).toBeVisible();
      expect(actions.count()).toBe(0);
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("refuses a day that has not come, keeping the form as typed", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await dayField(dialog).fill(addCivilDays(TODAY, 1));
      await realField(dialog).fill("123456");
      await submit(dialog).click();

      await expect(dialog.getByText(errors.reconcileFutureDay, { exact: true })).toBeVisible();
      await expect(realField(dialog)).toHaveValue("123456");
      await expect(dayField(dialog)).toHaveValue(dmy(addCivilDays(TODAY, 1)));
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("refuses a day before the latest reconciliation, naming that day", async ({ page }) => {
    const account = await seedAccount();
    const latest = addCivilDays(TODAY, -5);
    try {
      await seedReconciliation(account.id, latest, DERIVED_TODAY + 100_000);

      const dialog = await openDialog(page, account);
      await dayField(dialog).fill(addCivilDays(latest, -1));
      await realField(dialog).fill("480000");
      await submit(dialog).click();

      const [head, tail] = errors.reconcileBeforeLatest.split("{date}");
      const message = dialog.getByText(head, { exact: false });
      await expect(message).toBeVisible();
      const text = flat(await message.innerText());
      expect(text.startsWith(head)).toBe(true);
      expect(text.endsWith(tail.trim())).toBe(true);
      // The day is named, not left as the placeholder.
      const named = text.slice(head.length, text.length - tail.trim().length).trim();
      expect(named).not.toContain("{");
      expect(named).toContain(String(Number(latest.slice(8))));
      expect(await reconciliationsOf(account.id)).toHaveLength(1);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("refuses when the ledger moved after the figure was read, and shows the fresh one", async ({
    page,
  }) => {
    const account = await seedAccount();
    const extra = 700_000; // $ 7.000 more out of the account, after the dialog opened
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("480000");

      await asHarnessUser(async (tx) => {
        const [movement] = await tx<{ id: string }[]>`
          insert into transactions (from_account_id, amount_cents, occurred_at, description)
          values (${account.id}, ${extra}, ${TODAY}, ${`Tarde ${stamp}`})
          returning id`;
        await tx`
          insert into transaction_splits (transaction_id, category_id, amount_cents)
          values (${movement.id}, ${scope.categoryId}, ${extra})`;
      });

      await submit(dialog).click();

      await expect(dialog.getByText(errors.reconcileStale, { exact: true })).toBeVisible();
      await expect(line(dialog, accounts.reconcileDerived)).toContainText(
        peso((DERIVED_TODAY - extra) / 100),
      );
      await expect(realField(dialog)).toHaveValue("480000");
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
      expect(await adjustmentsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("refuses an account archived after the dialog opened: the failure toast, no success, nothing written", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("480000");

      // The menu hides Cuadrar on an archived account, so the only way to confirm
      // against one is an account archived under an open dialog.
      await fixtureSql`update accounts set archived_at = now() where id = ${account.id}`;

      await submit(dialog).click();

      await expect(page.getByText(errors.reconcileFailed, { exact: true })).toBeVisible();
      await expect(page.getByText(accounts.reconciled, { exact: true })).toHaveCount(0);
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
      expect(await adjustmentsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a forged confirm against an archived account is answered with the refusal, never ok", async ({ page }) => {
    // Kills: the `archived` refusal answering `{ ok: true }`.
    const live = await seedAccount();
    const archived = await seedAccount({ archived: true });
    try {
      const dialog = await openDialog(page, live);
      await realField(dialog).fill("480000");

      // The menu offers no Cuadrar on an archived account, so the confirm of the live
      // one is sent with the archived account's id swapped in.
      const answers: string[] = [];
      let forged = 0;
      await page.route("**/*", async (route) => {
        const request = route.request();
        const body = request.postData();
        if (request.method() === "POST" && request.headers()["next-action"] && body?.includes(live.id)) {
          forged += 1;
          const response = await route.fetch({ postData: body.replaceAll(live.id, archived.id) });
          answers.push(await response.text());
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });

      await submit(dialog).click();

      await expect(page.getByText(errors.reconcileFailed, { exact: true })).toBeVisible();
      expect(forged).toBe(1);
      expect(answers).toHaveLength(1);
      expect(answers[0]).not.toContain('"ok":true');
      expect(answers[0]).not.toMatch(/"gapCents"/);
      await expect(page.getByText(accounts.reconciled, { exact: true })).toHaveCount(0);
      expect(await reconciliationsOf(archived.id)).toHaveLength(0);
      expect(await adjustmentsOf(archived.id)).toHaveLength(0);
      expect(await reconciliationsOf(live.id)).toHaveLength(0);
    } finally {
      await dropAccount(live.id);
      await dropAccount(archived.id);
    }
  });

  test("refuses a doubled minus, and writes nothing", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("--5000");
      await submit(dialog).click();

      await expect(dialog.getByText(amountInvalid, { exact: true })).toBeVisible();
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("takes a minus on an asset and stores it negative", async ({ page }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("-5000");
      await submit(dialog).click();

      await expect(page.getByText(accounts.reconciled, { exact: true })).toBeVisible();
      await expect(dialog.getByText(amountInvalid, { exact: true })).toHaveCount(0);
      const rows = await reconciliationsOf(account.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].counted).toBe("-500000");
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("pending (B5) and cancel", () => {
  test("holds both buttons while the write is in flight", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("492000");

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
          await held;
        }
        await route.continue();
      });

      await submit(dialog).click();

      const pending = dialog.getByRole("button", { name: accounts.reconcilePending, exact: true });
      await expect(pending).toBeVisible();
      await expect(pending).toBeDisabled();
      await expect(dialog.getByRole("button", { name: common.cancel, exact: true })).toBeDisabled();
      await expect(realField(dialog)).toHaveJSProperty("readOnly", true);

      release();
      await expect(dialog.getByText(accounts.reconciled).or(historyFigures(dialog))).toBeVisible();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("holds the day and the real figure read-only while «Cuadrando…» shows (B5)", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("492000");

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
          await held;
        }
        await route.continue();
      });

      await submit(dialog).click();
      await expect(
        dialog.getByRole("button", { name: accounts.reconcilePending, exact: true }),
      ).toBeVisible();

      await expect(dayField(dialog)).toHaveJSProperty("readOnly", true);
      await expect(realField(dialog)).toHaveJSProperty("readOnly", true);
      // Typing into a read-only input changes nothing.
      await realField(dialog).press("Digit9");
      await expect(realField(dialog)).toHaveValue("492000");

      release();
      await expect(dialog.getByText(accounts.reconciled).or(historyFigures(dialog))).toBeVisible();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("Cancelar closes the dialog and writes nothing", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("492000");
      await dialog.getByRole("button", { name: common.cancel, exact: true }).click();

      await expect(dialog).toBeHidden();
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
      expect(await adjustmentsOf(account.id)).toHaveLength(0);
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

  test("offers no way to undo a reconciliation", async ({ page }) => {
    const account = await seedAccount();
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 48_500_000);

      const dialog = await openDialog(page, account);
      await expect(historyFigures(dialog)).toHaveCount(1);

      const names = await dialog.getByRole("button").evaluateAll((buttons) =>
        buttons.map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim()),
      );
      // The footer's two, the dialog's own close and the day field's calendar; a history row adds none.
      const named = names.filter((n) => !/^(cerrar|close|abrir calendario|open calendar)$/i.test(n));
      expect(named).toEqual(
        expect.arrayContaining([common.cancel, accounts.reconcileSubmit]),
      );
      expect(named).toHaveLength(2);
      await expect(dialog.getByRole("link")).toHaveCount(0);
      await expect(dialog.getByRole("menu")).toHaveCount(0);
      await expect(dialog.getByRole("menuitem")).toHaveCount(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("holds exactly the day and the real figure, with no sign control", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);

      await expect(dialog.locator("input:visible")).toHaveCount(2);
      await expect(dayField(dialog)).toBeVisible();
      await expect(realField(dialog)).toBeVisible();
      for (const role of ["switch", "checkbox", "radio", "combobox", "tab"] as const) {
        await expect(dialog.getByRole(role)).toHaveCount(0);
      }
      await expect(dialog.getByText("Sobregiro")).toHaveCount(0);
      await expect(dialog.getByText("A favor")).toHaveCount(0);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("at 360 px", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test("overflows nowhere and keeps every control at least 44 px on its short side, the hint drawn", async ({
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

test.describe("a figure below zero (board C1)", () => {
  test("opens the full keyboard, on a COP and on a USD account (C1d)", async ({ page }) => {
    const cop = await seedAccount();
    const usd = await seedAccount({ currency: "USD" });
    try {
      const copDialog = await openDialog(page, cop);
      await expect(realField(copDialog)).toHaveAttribute("inputmode", "text");
      await page.keyboard.press("Escape");
      await expect(copDialog).toBeHidden();

      const usdDialog = await openDialog(page, usd);
      await expect(realField(usdDialog)).toHaveAttribute("inputmode", "text");
    } finally {
      await dropAccount(cop.id);
      await dropAccount(usd.id);
    }
  });

  test("an asset empty sheet carries its help line and not the liability's (C1a)", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await expect(hint(dialog, hintAsset)).toBeVisible();
      await expect(hint(dialog, hintLiability)).toHaveCount(0);
      await expect(dialog.getByText(accounts.reconciliationsEmpty, { exact: true })).toBeVisible();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a liability empty sheet carries its own help line and not the asset's (C1b)", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      await expect(dialog.getByText(accounts.reconcileRealLiability, { exact: true })).toBeVisible();
      await expect(hint(dialog, hintLiability)).toBeVisible();
      await expect(hint(dialog, hintAsset)).toHaveCount(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("the help line sits under the field and above the gap line", async ({ page }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("492000");
      await expect(line(dialog, accounts.reconcileGap)).toBeVisible();

      const input = await realField(dialog).boundingBox();
      const help = await hint(dialog, hintAsset).boundingBox();
      const gap = await dialog.getByText(accounts.reconcileGap, { exact: true }).boundingBox();
      expect(input).not.toBeNull();
      expect(help).not.toBeNull();
      expect(gap).not.toBeNull();
      expect(help!.y).toBeGreaterThan(input!.y);
      expect(help!.y).toBeLessThan(gap!.y);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("typing -5000 on an asset deriving 0 reads the gap as −$ 5.000 (C1c)", async ({ page }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("-5000");

      await expect(realField(dialog)).toHaveValue("-5000");
      const gap = line(dialog, accounts.reconcileGap);
      await expect(gap).toBeVisible();
      expect(flat(await gap.innerText())).toContain(`${MINUS}$ 5.000`);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a doubled minus keeps the help line beside the refusal, and writes nothing (C1e)", async ({
    page,
  }) => {
    const account = await seedAccount();
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("--5000");
      await submit(dialog).click();

      await expect(dialog.getByText(amountInvalid, { exact: true })).toBeVisible();
      await expect(hint(dialog, hintAsset)).toBeVisible();
      await expect(realField(dialog)).toHaveValue("--5000");
      expect(await reconciliationsOf(account.id)).toHaveLength(0);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("keeps the help line, and the field read-only, while «Cuadrando…» shows (C1f)", async ({
    page,
  }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("-5000");

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
          await held;
        }
        await route.continue();
      });

      await submit(dialog).click();
      await expect(
        dialog.getByRole("button", { name: accounts.reconcilePending, exact: true }),
      ).toBeVisible();
      await expect(hint(dialog, hintAsset)).toBeVisible();
      await expect(realField(dialog)).toHaveJSProperty("readOnly", true);

      release();
      await expect(dialog.getByText(accounts.reconciled).or(historyFigures(dialog))).toBeVisible();
    } finally {
      await dropAccount(account.id);
    }
  });

  test("an asset counted at -5000 reads «Real −$ 5.000» in the history (C1g)", async ({ page }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog).fill("-5000");
      await submit(dialog).click();

      await expect(page.getByText(accounts.reconciled, { exact: true })).toBeVisible();
      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe(`Según HomeFund $ 0 · Real ${MINUS}$ 5.000`);
      expect(flat(await first.locator("..").innerText())).toContain(signed(-5_000));
      expect((await reconciliationsOf(account.id))[0].counted).toBe("-500000");
    } finally {
      await dropAccount(account.id);
    }
  });

  test("an overpaid card counted at -5000 reads «Real −$ 5.000» and stores 500000 (C1h)", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("-5000");
      await submit(dialog).click();

      await expect(page.getByText(accounts.reconciled, { exact: true })).toBeVisible();
      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe(`Según HomeFund $ 0 · Real ${MINUS}$ 5.000`);
      expect(flat(await first.locator("..").innerText())).toContain(signed(-5_000));
      expect((await reconciliationsOf(account.id))[0].counted).toBe("500000");
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card owing 120 000 counted at 100 000 still reads as a magnitude (C1h)", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("100000");
      await submit(dialog).click();

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe("Según HomeFund $ 120.000 · Real $ 100.000");
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a history row seeded below zero on each kind reads its figures signed", async ({
    page,
  }) => {
    // The sheet draws the row from storage, never from what the session just typed.
    const asset = await seedAccount({ openingCents: 0, spendCents: 0 });
    const card = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      await seedReconciliation(asset.id, addCivilDays(TODAY, -3), -500_000);
      // Counted +$ 5.000 of credit on a card that owed $ 120.000.
      await seedReconciliation(card.id, addCivilDays(TODAY, -3), 500_000);

      const assetDialog = await openDialog(page, asset);
      expect(flat(await historyFigures(assetDialog).first().innerText())).toBe(
        `Según HomeFund $ 0 · Real ${MINUS}$ 5.000`,
      );
      await page.keyboard.press("Escape");
      await expect(assetDialog).toBeHidden();

      const cardDialog = await openDialog(page, card);
      expect(flat(await historyFigures(cardDialog).first().innerText())).toBe(
        `Según HomeFund $ 120.000 · Real ${MINUS}$ 5.000`,
      );
    } finally {
      await dropAccount(asset.id);
      await dropAccount(card.id);
    }
  });
});

test.describe("line 3 «Según HomeFund» in the field's frame (RF-137, board C1)", () => {
  test("a card owing $ 120.000 reads «$ 120.000», with no minus", async ({ page }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} $ 120.000`);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card in credit by $ 5.000 reads «−$ 5.000»", async ({ page }) => {
    // A card cannot open in credit; a count of +$ 5.000 on a card opened at 0 books the credit.
    const account = await seedAccount({ kind: "liability", openingCents: 0 });
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 500_000);
      const dialog = await openDialog(page, account);
      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} ${MINUS}$ 5.000`);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("an asset at −$ 5.000 keeps its sign, one minus only", async ({ page }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 500_000 });
    try {
      const dialog = await openDialog(page, account);
      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} ${MINUS}$ 5.000`);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card owing $ 315.000 counted at $ 300.000 reads the same frame in line 3 and the history", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -31_500_000 });
    try {
      const dialog = await openDialog(page, account);
      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} $ 315.000`);

      await realField(dialog, accounts.reconcileRealLiability).fill("300000");
      await submit(dialog).click();

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe("Según HomeFund $ 315.000 · Real $ 300.000");
      // The sheet refreshes to the debt the count made true.
      await expect
        .poll(async () => derivedLine(dialog))
        .toBe(`${accounts.reconcileDerived} $ 300.000`);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("an asset history seeded at −$ 5.000 reads exactly, with no doubled minus anywhere", async ({
    page,
  }) => {
    const account = await seedAccount({ openingCents: 0, spendCents: 0 });
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), -500_000);
      const dialog = await openDialog(page, account);

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe(`Según HomeFund $ 0 · Real ${MINUS}$ 5.000`);
      expect(await derivedLine(dialog)).toBe(`${accounts.reconcileDerived} ${MINUS}$ 5.000`);
      expect(await dialog.innerText()).not.toMatch(/[−-]\s*[−-]/);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a history row whose derived figure was −$ 5.000 on an asset keeps that minus", async ({
    page,
  }) => {
    // 3 days ago the account stood at −$ 5.000 (it spent that from nothing 10 days ago); the count was $ 0.
    const account = await seedAccount({ openingCents: 0, spendCents: 500_000 });
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 0);
      const dialog = await openDialog(page, account);

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe(`Según HomeFund ${MINUS}$ 5.000 · Real $ 0`);
    } finally {
      await dropAccount(account.id);
    }
  });
});

test.describe("the gap in the field's frame (RF-137, board C1)", () => {
  // The span `Money` draws for a figure, found by its text inside a line.
  function gapFigure(dialog: Locator, text: string): Locator {
    return line(dialog, accounts.reconcileGap).locator("span").filter({ hasText: text }).last();
  }

  test("a card owing $ 404.900 counted at $ 400.000 reads −$ 4.900 in the good tone", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -40_490_000 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("400000");

      const figureSpan = gapFigure(dialog, signed(-4_900));
      await expect(figureSpan).toBeVisible();
      expect(flat(await figureSpan.innerText())).toBe(signed(-4_900));
      await expect(figureSpan).toHaveCSS("color", await colorOf(dialog, "--jade-11"));

      await submit(dialog).click();
      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.innerText())).toBe("Según HomeFund $ 404.900 · Real $ 400.000");
      expect(flat(await first.locator("..").innerText())).toContain(signed(-4_900));
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card owing $ 120.000 counted at $ 130.000 reads +$ 10.000 in the plain dark tone", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("130000");

      const figureSpan = gapFigure(dialog, signed(10_000));
      await expect(figureSpan).toBeVisible();
      await expect(figureSpan).toHaveCSS("color", await colorOf(dialog, "--gray-12"));
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card at $ 0 counted at −5000 reads −$ 5.000 in the good tone", async ({ page }) => {
    const account = await seedAccount({ kind: "liability", openingCents: 0 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("-5000");

      const figureSpan = gapFigure(dialog, signed(-5_000));
      await expect(figureSpan).toBeVisible();
      await expect(figureSpan).toHaveCSS("color", await colorOf(dialog, "--jade-11"));
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card owing $ 120.000 counted at $ 120.000 says it balances, with no sign", async ({
    page,
  }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("120000");

      await expect(dialog.getByText(accounts.reconcileBalanced, { exact: true })).toBeVisible();
      const gap = line(dialog, accounts.reconcileGap);
      await expect(gap).toContainText(peso(0));
      expect(flat(await gap.innerText())).not.toMatch(/[+−]/);
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card seeded in credit reads its history gap as −$ 125.000", async ({ page }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      await seedReconciliation(account.id, addCivilDays(TODAY, -3), 500_000);
      const dialog = await openDialog(page, account);

      const first = historyFigures(dialog).first();
      await expect(first).toBeVisible();
      expect(flat(await first.locator("..").innerText())).toContain(signed(-125_000));
    } finally {
      await dropAccount(account.id);
    }
  });

  test("a card booking keeps the adjustment in the balance's frame", async ({ page }) => {
    const account = await seedAccount({ kind: "liability", openingCents: -12_000_000 });
    try {
      const dialog = await openDialog(page, account);
      await realField(dialog, accounts.reconcileRealLiability).fill("100000");
      await expect(line(dialog, accounts.reconcileGap)).toContainText(signed(-20_000));
      await submit(dialog).click();
      await expect(historyFigures(dialog).first()).toBeVisible();

      expect((await reconciliationsOf(account.id)).map((r) => r.counted)).toEqual(["-10000000"]);
      expect(await adjustmentsOf(account.id)).toEqual([
        { amount: "2000000", to_me: true, on: TODAY },
      ]);
    } finally {
      await dropAccount(account.id);
    }
  });
});

// A theme variable resolved to the colour the browser computes for it.
async function colorOf(dialog: Locator, variable: string): Promise<string> {
  return dialog.evaluate((node, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    node.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, variable);
}
