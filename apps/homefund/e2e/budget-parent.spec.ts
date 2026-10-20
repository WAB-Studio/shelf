/**
 * RF-160: a budget on a parent category counts the spend of its subcategories, and the
 * movements filtered by that parent list theirs too. «Vivienda» fills as «Arriendo» and
 * «Servicios» are spent; its card and its movement list tell the same story, and a parent
 * with no spend reads zero.
 *
 * Everything is personal to the harness identity, written by id and dropped by id.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import { formatMoney } from "@/lib/money";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const RENT = 1_000_000;
const UTILITIES = 2_000_000;
const DIRECT = 500_000;
const STRANGER = 700_000;
const LIMIT = 9_000_000;
const SPENT = RENT + UTILITIES + DIRECT;

const money = (cents: number) => formatMoney(cents, "COP", "es");

const ids = {
  parent: randomUUID(),
  rent: randomUUID(),
  utilities: randomUUID(),
  other: randomUUID(),
  otherChild: randomUUID(),
  empty: randomUUID(),
  budget: randomUUID(),
  emptyBudget: randomUUID(),
};
const CATEGORIES = [ids.parent, ids.rent, ids.utilities, ids.other, ids.otherChild, ids.empty];
const TITLE = `Vivienda ${stamp}`;
const EMPTY_TITLE = `Vacio ${stamp}`;
// A movement with no description is titled by its first split's category, on the table and on the phone's card.
const NAME = {
  parent: `Vivienda cat ${stamp}`,
  rent: `Arriendo cat ${stamp}`,
  utilities: `Servicios cat ${stamp}`,
  stranger: `Otro hija ${stamp}`,
};

test.beforeEach(async () => {
  await clearLedger();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.parent}, ${scope.userId}, ${NAME.parent}, 'expense', '#8C4A4A'),
             (${ids.other}, ${scope.userId}, ${`Otro cat ${stamp}`}, 'expense', '#4C8C4A'),
             (${ids.empty}, ${scope.userId}, ${`Vacia cat ${stamp}`}, 'expense', '#4C4A8C')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color, parent_id)
      values (${ids.rent}, ${scope.userId}, ${NAME.rent}, 'expense', '#8C4A4A', ${ids.parent}),
             (${ids.utilities}, ${scope.userId}, ${NAME.utilities}, 'expense', '#8C4A4A', ${ids.parent}),
             (${ids.otherChild}, ${scope.userId}, ${NAME.stranger}, 'expense', '#4C8C4A', ${ids.other})`;
    for (const [category, cents] of [
      [ids.rent, RENT],
      [ids.utilities, UTILITIES],
      [ids.parent, DIRECT],
      [ids.otherChild, STRANGER],
    ] as const) {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at)
        values (${scope.accountId}, ${cents}, (now() at time zone ${TIME_ZONE})::date)
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${category}, ${cents})`;
    }
    await tx`
      insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name)
      values (${ids.budget}, ${scope.userId}, ${ids.parent}, 'monthly', ${LIMIT}, 80, ${TITLE}),
             (${ids.emptyBudget}, ${scope.userId}, ${ids.empty}, 'monthly', ${LIMIT}, 80, ${EMPTY_TITLE})`;
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from budgets where id in (${ids.budget}, ${ids.emptyBudget})`;
  await clearLedger();
  await fixtureSql`delete from categories where id in ${fixtureSql(CATEGORIES)} and parent_id is not null`;
  await fixtureSql`delete from categories where id in ${fixtureSql(CATEGORIES)}`;
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A card draws «spent / limit» as one text and the table draws each in its own cell, so a figure is found
// as a whole number: not the tail of a longer one.
const figure = (page: Page, cents: number): Locator =>
  page.getByText(new RegExp(`(?<![\\d.,])${escape(money(cents))}(?![\\d.,])`)).filter({ visible: true });

const visible = (page: Page, text: string): Locator => page.getByText(text).filter({ visible: true });

test("the parent's card reads what its subcategories and itself spent", async ({ page }) => {
  // Kills: the budget's sum keyed on the parent's own category alone (reads 5.000, not 35.000).
  await page.goto("/es/planning/budgets");

  await expect(figure(page, SPENT).first()).toBeVisible();
  await expect(figure(page, RENT + DIRECT)).toHaveCount(0);
  await expect(figure(page, DIRECT)).toHaveCount(0);
});

test("the card's remaining is the limit less the whole family's spend", async ({ page }) => {
  // Kills: the remaining derived from the parent's own splits.
  await page.goto("/es/planning/budgets");

  await expect(figure(page, LIMIT - SPENT).first()).toBeVisible();
});

test("a parent with no spend reads zero and a full remaining", async ({ page }) => {
  // Kills: a null spend drawn as a blank, or the empty parent borrowing another's children.
  await page.goto("/es/planning/budgets");

  await expect(figure(page, 0).first()).toBeVisible();
  await expect(figure(page, LIMIT).first()).toBeVisible();
});

test("the movements filtered by the parent are the three the card counts", async ({ page }) => {
  // Kills: the filter matching the parent's own splits alone, or leaking another parent's child.
  await page.goto(`/es/movements?category=${ids.parent}`);

  await expect(visible(page, NAME.rent).first()).toBeVisible();
  await expect(visible(page, NAME.utilities).first()).toBeVisible();
  await expect(visible(page, NAME.parent).first()).toBeVisible();
  await expect(visible(page, NAME.stranger)).toHaveCount(0);
});

test("filtering by a subcategory lists that subcategory alone", async ({ page }) => {
  // Kills: the filter widened to the whole family from a child.
  await page.goto(`/es/movements?category=${ids.rent}`);

  await expect(visible(page, NAME.rent).first()).toBeVisible();
  await expect(visible(page, NAME.utilities)).toHaveCount(0);
  await expect(visible(page, NAME.parent)).toHaveCount(0);
});
