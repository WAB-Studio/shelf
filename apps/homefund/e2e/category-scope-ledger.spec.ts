/**
 * RF-140 (boards C3b-C3d): a fund category is written «{nombre} · fondo» in a
 * movement's detail, in the split editor of the edit form and of quick entry, and
 * in the dashboard's recent lines; a personal one of the same name stays bare.
 * The person holds both under one name, so only the mark tells them apart.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, clearLedger, readScope, seedGroup, test } from "./global-setup";

const transactions = messages.transactions;
const scope = readScope();

const STAMP = randomUUID().slice(0, 8);
const NAME = `T4 Mercado ${STAMP}`;
const MARKED = `${NAME} · fondo`;
const FUND_ACCOUNT = `Cuenta del fondo ${STAMP}`;
const LONG_NAME = `T4 ${STAMP} ${"Categoría larguísima ".repeat(2)}`.slice(0, 40);
const CENTS = 4_500_000;

const ids = {
  account: randomUUID(),
  fund: randomUUID(),
  own: randomUUID(),
  long: randomUUID(),
  foreign: randomUUID(),
};
const movementIds = { fund: "", own: "", foreign: "" };

test.beforeEach(async () => {
  await clearLedger();
  const { groupId } = await seedGroup();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.account}, ${groupId}, true, ${FUND_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.fund}, ${groupId}, ${NAME}, 'expense', '#8C4A4A'),
             (${ids.long}, ${groupId}, ${LONG_NAME}, 'expense', '#8C4A4A')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.own}, ${scope.userId}, ${NAME}, 'expense', '#4C8C4A')`;
    for (const [key, account, category] of [
      ["fund", ids.account, ids.fund],
      ["own", scope.accountId, ids.own],
    ] as const) {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${account}, ${CENTS}, (now() at time zone ${TIME_ZONE})::date)
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${category}, ${CENTS})`;
      movementIds[key] = movement.id;
    }
  });
});

test.afterEach(async () => {
  await fixtureSql`
    delete from transactions
    where id in (
      select transaction_id from transaction_splits
      where category_id in (${ids.fund}, ${ids.own}, ${ids.long}, ${ids.foreign}))`;
  await fixtureSql`delete from categories where id in (${ids.fund}, ${ids.own}, ${ids.long}, ${ids.foreign})`;
  await fixtureSql`delete from accounts where id = ${ids.account}`;
  await clearGroup();
  await clearLedger();
});

const visible = (page: Page, text: string, exact = true) =>
  page.getByText(text, { exact }).filter({ visible: true });

test("the detail of the fund's expense reads «· fondo» and the personal one bare (C3b)", async ({
  page,
}) => {
  // Kills: the detail's names map left bare; every scope marked.
  await page.goto(`/es/movements/${movementIds.fund}`);
  await expect(visible(page, MARKED).first()).toBeVisible();

  await page.goto(`/es/movements/${movementIds.own}`);
  await expect(visible(page, NAME).first()).toBeVisible();
  await expect(visible(page, MARKED)).toHaveCount(0);
  await expect(page.getByText("· fondo")).toHaveCount(0);
});

test("a split whose category the caller cannot read keeps the kind word", async ({ page }) => {
  // Kills: a missing id answered with mark("") instead of the fallback.
  await fixtureSql`
    insert into categories (id, owner_user_id, name, kind, color)
    values (${ids.foreign}, ${scope.memberUserId}, ${`Ajena ${STAMP}`}, 'expense', '#4C4A8C')`;
  // The scope trigger refuses this pairing on purpose; it is switched off for
  // the seed alone, to reach the one state the app no longer writes.
  const movement = await fixtureSql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const [row] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, created_by, group_id, currency)
      select ${ids.account}, ${CENTS}, (now() at time zone ${TIME_ZONE})::date, ${scope.userId}, group_id, settlement_currency
      from accounts where id = ${ids.account}
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${row.id}, ${ids.foreign}, ${CENTS})`;
    return row;
  });
  movementIds.foreign = movement.id;

  await page.goto(`/es/movements/${movement.id}`);
  await expect(visible(page, transactions.kindExpense).first()).toBeVisible();
  await expect(page.getByText("· fondo")).toHaveCount(0);
});

test.describe("the edit form's split editor (C3c)", () => {
  async function openEdit(page: Page, id: string) {
    await page.goto(`/es/movements/${id}`);
    await page
      .getByRole("button", { name: transactions.edit, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    return page.getByRole("combobox", {
      name: transactions.splitRowCategory.replace("{position}", "1"),
      exact: true,
    });
  }

  test("the trigger reads the marked name and the list holds the fund's set marked", async ({ page }) => {
    // Kills: the trigger rendering the bare name; the scope filter dropped.
    const trigger = await openEdit(page, movementIds.fund);
    await expect(trigger).toHaveText(MARKED);
    await trigger.click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    const texts = await options.allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.trim().endsWith(" · fondo")).toBe(true);
    expect(texts.map((text) => text.trim())).not.toContain(NAME);
  });

  test("a personal expense's trigger stays bare", async ({ page }) => {
    const trigger = await openEdit(page, movementIds.own);
    await expect(trigger).toHaveText(NAME);
  });
});

test.describe("quick entry", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the sheet is the phone's");
  });

  async function openSheet(page: Page, typed: string) {
    await page.goto("/es");
    await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
    await page.getByRole("option", { name: FUND_ACCOUNT, exact: true }).click();
    await sheet.getByRole("textbox", { name: transactions.quickTitle, exact: true }).fill(typed);
    return sheet;
  }

  test("still infers the category from a typed bare name and shows it marked", async ({ page }) => {
    // Kills: the interpreter fed the marked names.
    const sheet = await openSheet(page, `45000 ${NAME}`);
    await expect(
      sheet.getByRole("combobox", {
        name: transactions.splitRowCategory.replace("{position}", "1"),
        exact: true,
      }),
    ).toHaveText(MARKED);
  });

  test("a long marked name does not widen the sheet at 360 px", async ({ page }) => {
    const sheet = await openSheet(page, `45000 ${LONG_NAME}`);
    await expect(
      sheet.getByRole("combobox", {
        name: transactions.splitRowCategory.replace("{position}", "1"),
        exact: true,
      }),
    ).toContainText("· fondo");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const clipped = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(clipped).toBeLessThanOrEqual(0);
  });
});

test("the dashboard's recent lines mark the fund's category and leave the personal one bare (C3d)", async ({
  page,
}) => {
  // Kills: the page's names map left bare.
  await page.goto("/es");
  await expect(visible(page, MARKED).first()).toBeVisible();
  await expect(visible(page, NAME).first()).toBeVisible();
});
