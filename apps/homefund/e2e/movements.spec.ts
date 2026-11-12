/**
 * The ledger, which no check had opened: the rows render, a filter narrows them
 * in Postgres and clearing brings them back. The filters live in the URL so the view
 * is shareable (RF-23, RNF-09), which is why the query string is asserted
 * alongside what is on screen.
 *
 * The two movements are seeded rather than written through the interface: this
 * spec is about reading a ledger that already holds both kinds.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import { MIN_TITLE_PX, pageOverflow, rightOverhang } from "./fit";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const common = messages.common;
const recurringRules = messages.recurringRules;
const scope = readScope();

// A row is titled by its first split's category, so the income row needs a
// category of its own to be told apart from the expense's.
const incomeCategoryId = randomUUID();
const incomeCategoryName = `Ingreso ${randomUUID().slice(0, 8)}`;

const EXPENSE_CENTS = 3200000;
const INCOME_CENTS = 7100000;
const EXPENSE_DESCRIPTION = "Harness gasto";

test.beforeEach(async () => {
  await clearLedger();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${incomeCategoryId}, ${scope.userId}, ${incomeCategoryName}, 'income', '#4C8C4A')`;

    const [expense] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${EXPENSE_CENTS},
        (now() at time zone ${TIME_ZONE})::date, ${EXPENSE_DESCRIPTION})
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${expense.id}, ${scope.categoryId}, ${EXPENSE_CENTS})`;

    const [income] = await tx<{ id: string }[]>`
      insert into transactions (to_account_id, amount_cents, occurred_at, description)
      values (
        ${scope.accountId}, ${INCOME_CENTS},
        (now() at time zone ${TIME_ZONE})::date, 'Harness ingreso')
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${income.id}, ${incomeCategoryId}, ${INCOME_CENTS})`;
  });
});

test.afterEach(async () => {
  await clearLedger();
  await fixtureSql`delete from categories where id = ${incomeCategoryId}`;
});

test("lists both movements, narrows to one by kind and restores them on clear", async ({
  page,
}, testInfo) => {
  // Both shapes stay mounted at every width and CSS displays one of them, so a
  // page-wide locator matches the hidden one too. Every locator here is scoped
  // to the shape this project's viewport renders, and each viewport narrows
  // through the control it actually shows: the laptop's Tipo select and its
  // chip, the phone's segmented chips and its filter panel.
  const desktop = testInfo.project.name === "desktop";
  const ledger = page.getByRole("table", { name: transactions.listTitle });
  // On the laptop a row is named by its category cell; on the phone the whole
  // card is one link, and the category is its title.
  const rowFor = (category: string) =>
    desktop
      ? ledger.getByText(category, { exact: true })
      : page.getByRole("link", { name: category });

  const expenseRow = rowFor(scope.categoryName);
  const incomeRow = rowFor(incomeCategoryName);

  await page.goto("/es/movements");
  await expect(expenseRow).toBeVisible();
  await expect(incomeRow).toBeVisible();

  // The kind the control names is derived from the accounts the movement
  // carries — never stored, never chosen (RF-19).
  if (desktop) {
    await page.getByLabel(transactions.typeLabel, { exact: true }).click();
    await page
      .getByRole("option", { name: transactions.filterIncome, exact: true })
      .click();
  } else {
    await page
      .getByRole("radio", { name: transactions.filterIncome, exact: true })
      .click();
  }

  await expect(page).toHaveURL("/es/movements?type=income");
  await expect(incomeRow).toBeVisible();
  await expect(expenseRow).toHaveCount(0);

  // Clearing drops the key rather than emptying it: on the laptop from the chip
  // that names the narrowing, on the phone from the filter panel.
  if (desktop) {
    await page
      .getByRole("button", {
        name: common.removeFilter.replace("{label}", transactions.filterIncome),
        exact: true,
      })
      .click();
  } else {
    await page
      .getByRole("button", { name: transactions.filtersLabel, exact: true })
      .click();
    await page
      .getByRole("button", { name: transactions.clearFilters, exact: true })
      .click();
  }

  await expect(page).toHaveURL("/es/movements");
  await expect(expenseRow).toBeVisible();
  await expect(incomeRow).toBeVisible();
});

test.describe("a movement between two currencies", () => {
  const foreignCategoryId = randomUUID();
  const foreignCategoryName = `Compra en dólares ${randomUUID().slice(0, 8)}`;
  let movementId = "";

  // A dollar purchase out of a peso account (RF-121, RF-122): the amount is
  // booked in dollars and carries the peso estimate a person confirmed,
  // `counter_is_estimate` true until a statement replaces it (RF-123).
  const USD_CENTS = 8_000;
  const COP_ESTIMATE_CENTS = 3_200_000;

  // The file's own `beforeEach`/`afterEach` above call `clearLedger`, unscoped
  // to any describe, so this fixture is written inside a `beforeEach` of its
  // own — the outer one already ran and cleared the ledger by the time this
  // runs, where a `beforeAll` here would have landed before it and been wiped.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${foreignCategoryId}, ${scope.userId}, ${foreignCategoryName}, 'expense', '#4C8C4A')`;

      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (
          from_account_id, amount_cents, occurred_at, description,
          currency, counter_amount_cents, counter_is_estimate)
        values (
          ${scope.accountId}, ${USD_CENTS},
          (now() at time zone ${TIME_ZONE})::date, 'Harness compra en dólares',
          'USD', ${COP_ESTIMATE_CENTS}, true)
        returning id`;
      movementId = movement.id;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movementId}, ${foreignCategoryId}, ${USD_CENTS})`;
    });
  });

  test.afterEach(async () => {
    // Ahead of the outer `clearLedger`: the split's foreign key into this
    // category outlives it otherwise, since this hook runs before that one.
    await fixtureSql`delete from transactions where id = ${movementId}`;
    await fixtureSql`delete from categories where id = ${foreignCategoryId}`;
  });

  test("the detail reads the purchase in dollars, its peso estimate and the rate between them", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";

    await page.goto(`/es/movements/${movementId}`);

    if (desktop) {
      // `MovementDetailDesktop` draws the counter figure unlabelled, right under
      // the hero amount — there is no "Monto en destino" row to scope by here,
      // so the block is read by the description that sits beside it instead.
      // The description repeats in the "Nota" field further down the page; the
      // hero block is the first of the two matches.
      const panel = page
        .getByText("Harness compra en dólares", { exact: true })
        .locator("..")
        .first();
      const panelText = await panel.innerText();
      expect(panelText).toContain("≈");
      expect(panelText.replace(/\D/g, "")).toContain(String(COP_ESTIMATE_CENTS / 100));
    } else {
      const counterRow = page
        .getByText(transactions.counterAmountLabel, { exact: true })
        .locator("..")
        .filter({ visible: true });
      await expect(counterRow).toHaveCount(1);
      // The estimate mark is the figure's own prefix (`Money`'s `estimate`
      // prop), never a separate word next to it.
      await expect(counterRow).toContainText("≈");
      expect((await counterRow.innerText()).replace(/\D/g, "")).toBe(
        String(COP_ESTIMATE_CENTS / 100),
      );
    }

    // The rate is a labelled row on both shapes, unlike the counter figure above.
    const rateRow = page
      .getByText(transactions.rateLabel, { exact: true })
      .locator("..")
      .filter({ visible: true });
    await expect(rateRow).toHaveCount(1);
    // 1 USD = (32.000 pesos estimated / 80 dollars) pesos.
    await expect(rateRow).toContainText(
      String(COP_ESTIMATE_CENTS / 100 / (USD_CENTS / 100)),
    );
  });
});

test.describe("a rule's row opens what it generated, not the whole account (RF-127)", () => {
  // Two categories, not one: the rule's pair and the manual movement need a
  // text of their own, since a phone card is titled by its category (never its
  // description) and the laptop's category cell repeats across rows sharing one.
  const generatedCategoryId = randomUUID();
  const generatedCategoryName = `Auto ${randomUUID().slice(0, 8)}`;
  const manualCategoryId = randomUUID();
  const manualCategoryName = `Manual ${randomUUID().slice(0, 8)}`;
  const ruleDescription = `Harness suscripción ${randomUUID().slice(0, 8)}`;
  const RULE_CENTS = 900000;
  const MANUAL_CENTS = 500000;
  let ruleId = "";
  let manualId = "";

  // The outer `beforeEach` above already clears the ledger for every test in
  // this file, so this fixture runs after that reset, same as the dollars
  // describe above.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values
          (${generatedCategoryId}, ${scope.userId}, ${generatedCategoryName}, 'expense', '#4C8C4A'),
          (${manualCategoryId}, ${scope.userId}, ${manualCategoryName}, 'expense', '#4C8C4A')`;

      const [rule] = await tx<{ id: string }[]>`
        insert into recurring_rules (
          from_account_id, amount_cents, category_id, description,
          frequency, interval_n, day_of_month, next_run_on)
        values (
          ${scope.accountId}, ${RULE_CENTS}, ${generatedCategoryId}, ${ruleDescription},
          'monthly', 1, 1, (now() at time zone ${TIME_ZONE})::date)
        returning id`;
      ruleId = rule.id;

      // The two the rule generated, carrying its id.
      for (const suffix of ["1", "2"]) {
        const [generated] = await tx<{ id: string }[]>`
          insert into transactions (
            from_account_id, amount_cents, occurred_at, description, recurring_rule_id)
          values (
            ${scope.accountId}, ${RULE_CENTS},
            (now() at time zone ${TIME_ZONE})::date, ${"Harness generado " + suffix},
            ${ruleId})
          returning id`;
        await tx`
          insert into transaction_splits (transaction_id, category_id, amount_cents)
          values (${generated.id}, ${generatedCategoryId}, ${RULE_CENTS})`;
      }

      // The third, manual, movement of this same account: what an `?account=`
      // filter would still show and an `?rule=` filter must not.
      const [manual] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (
          ${scope.accountId}, ${MANUAL_CENTS},
          (now() at time zone ${TIME_ZONE})::date, 'Harness manual de la misma cuenta')
        returning id`;
      manualId = manual.id;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${manualId}, ${manualCategoryId}, ${MANUAL_CENTS})`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from transactions where recurring_rule_id = ${ruleId} or id = ${manualId}`;
    await fixtureSql`delete from recurring_rules where id = ${ruleId}`;
    await fixtureSql`delete from categories where id in (${generatedCategoryId}, ${manualCategoryId})`;
  });

  test("the row menu's \"view generated\" opens the rule's two movements and none of the account's others", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";

    await page.goto("/es/planning/recurring");

    // The trigger's accessible name is built from the row it belongs to
    // (`RowMenu`), so it is safe to locate page-wide: Chromium drops the
    // `display: none` shape's subtree from the accessibility tree, so only the
    // width this project draws ever answers a `getByRole` query.
    await page
      .getByRole("button", {
        name: common.actionsFor.replace("{name}", ruleDescription),
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: recurringRules.rowViewGenerated, exact: true })
      .click();

    await expect(page).toHaveURL(`/es/movements?rule=${ruleId}`);

    const ledger = page.getByRole("table", { name: transactions.listTitle });
    // On the laptop a row is named by its category cell; on the phone the
    // whole card is one link, and the category is its title.
    const rowsFor = (category: string) =>
      desktop
        ? ledger.getByText(category, { exact: true })
        : page.getByRole("link", { name: category });

    await expect(rowsFor(generatedCategoryName)).toHaveCount(2);
    await expect(rowsFor(manualCategoryName)).toHaveCount(0);

    // The chip is a laptop control (RF-127, RF-125); the phone's filter panel
    // draws no chips at all, so this half of the assertion is the laptop's.
    if (desktop) {
      await expect(
        page.getByRole("button", {
          name: common.removeFilter.replace("{label}", ruleDescription),
          exact: true,
        }),
      ).toBeVisible();
    }
  });
});

// RF-137, RF-138: an adjustment (a «Descuadre») reads the same wherever a
// movement is listed or opened, is signed in plain ink, stays out of the
// list's net and is never editable. Written from boards B9 and B10 of the
// cuadre plan; the adjustment is booked by the database's own trigger from a
// seeded reconciliation, never inserted by hand.
test.describe("an adjustment among the movements (RF-137, RF-138)", () => {
  const BASE_STAMP = randomUUID().slice(0, 8);
  const REC_DAY = addCivilDays(todayInBogota(), -1);
  const OPENING = 50_000_000;

  let accountId = "";
  let accountName = "";
  let adjustmentId = "";

  // Intl separates symbol and figure with a no-break space.
  const flat = (text: string) => text.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();

  async function seedAdjustment(gapCents: number) {
    accountId = randomUUID();
    accountName = `Banco ${BASE_STAMP}-${Math.abs(gapCents)}`;
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (
          ${accountId}, ${scope.userId}, ${accountName}, 'asset', 'bank',
          ${OPENING}, ${addCivilDays(todayInBogota(), -30)})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${accountId}, ${REC_DAY}, ${OPENING + gapCents})`;
    });
    const [row] = await fixtureSql<{ id: string }[]>`
      select id from transactions
      where reconciliation_id is not null
        and (from_account_id = ${accountId} or to_account_id = ${accountId})`;
    adjustmentId = row.id;
  }

  test.afterEach(async () => {
    if (!accountId) return;
    await fixtureSql`
      delete from transactions
      where from_account_id = ${accountId} or to_account_id = ${accountId}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
    await fixtureSql`delete from accounts where id = ${accountId}`;
    accountId = "";
  });

  // The row a viewport draws: the laptop's table row, the phone's card link.
  function adjustmentRow(page: import("@playwright/test").Page, desktop: boolean) {
    return desktop
      ? page
          .getByRole("table", { name: transactions.listTitle })
          .getByRole("row")
          .filter({ hasText: transactions.kindAdjustment })
      : page.getByRole("link").filter({ hasText: transactions.kindAdjustment });
  }

  test("a positive adjustment reads «Descuadre», the account and +$ 12.000 in the list", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    await seedAdjustment(1_200_000);

    await page.goto("/es/movements");

    const row = adjustmentRow(page, desktop);
    await expect(row).toHaveCount(1);
    const text = flat(await row.innerText());
    expect(text).toContain(transactions.kindAdjustment);
    expect(text).toContain(accountName);
    expect(text).toContain("+$ 12.000");
    expect(text).not.toContain(transactions.kindExpense);
    expect(text).not.toContain(transactions.kindIncome);
    expect(text).not.toContain(transactions.kindTransfer);
  });

  test("the detail is B10: «Descuadre», the figure, the fix line, no Editar and no Eliminar", async ({
    page,
  }) => {
    await seedAdjustment(1_200_000);

    await page.goto(`/es/movements/${adjustmentId}`);

    await expect(
      page
        .getByRole("heading", { name: transactions.kindAdjustment, exact: true })
        .filter({ visible: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText(transactions.adjustmentFix, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(page.getByText(accountName).filter({ visible: true }).first()).toBeVisible();
    expect(flat(await page.locator("main").innerText())).toContain("+$ 12.000");

    await expect(
      page.getByRole("button", { name: transactions.edit, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: transactions.delete, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: transactions.edit, exact: true }),
    ).toHaveCount(0);
  });
});

// RF-138, RF-23, RF-140 (module 32, boards C2 and C3a): the type control offers
// «Descuadre» at every width, the laptop's meta counts the adjustments and
// drops the net, and a category of the fund reads «{nombre} · fondo» wherever
// the ledger names one. Written from the plan's Done table, not from the code.
test.describe("the «Descuadre» filter (RF-138, boards C2a-C2e)", () => {
  const STAMP = randomUUID().slice(0, 8);
  const DESCUADRE = transactions.filterAdjustments;
  const TYPE_ORDER = [
    transactions.filterAll,
    transactions.filterExpenses,
    transactions.filterIncome,
    transactions.filterTransfers,
    DESCUADRE,
  ];
  const flat = (text: string) => text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

  let accountId = "";

  // Two adjustments on one account, booked by the database's own trigger from
  // two reconciliations: +$ 12.000 the day before yesterday, then −$ 8.000.
  test.beforeEach(async () => {
    accountId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (
          ${accountId}, ${scope.userId}, ${`Banco ${STAMP}`}, 'asset', 'bank',
          50_000_000, ${addCivilDays(todayInBogota(), -30)})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${accountId}, ${addCivilDays(todayInBogota(), -2)}, ${51_200_000})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${accountId}, ${addCivilDays(todayInBogota(), -1)}, ${50_400_000})`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`
      delete from transactions where from_account_id = ${accountId} or to_account_id = ${accountId}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
    await fixtureSql`delete from accounts where id = ${accountId}`;
  });

  const typeRadios = (page: import("@playwright/test").Page) =>
    page.getByRole("radio").filter({ visible: true });
  const adjustmentCards = (page: import("@playwright/test").Page) =>
    page.getByRole("link").filter({ hasText: DESCUADRE }).filter({ visible: true });

  test("the phone offers five types in order, Descuadre last (C2a) @mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stacked control is the phone's");
    // Kills: the fifth item omitted.
    await page.goto("/es/movements");
    await expect(typeRadios(page)).toHaveCount(TYPE_ORDER.length);
    for (const [index, name] of TYPE_ORDER.entries()) {
      await expect(typeRadios(page).nth(index)).toHaveAccessibleName(name);
    }
  });

  test("picking Descuadre on the phone narrows to the two adjustments (C2b) @mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stacked control is the phone's");
    // Kills: the fifth item carrying another value (the URL says transfer).
    await page.goto("/es/movements");
    await expect(page.getByRole("link", { name: scope.categoryName })).toBeVisible();

    await page.getByRole("radio", { name: DESCUADRE, exact: true }).click();

    await expect(page).toHaveURL("/es/movements?type=adjustment");
    await expect(adjustmentCards(page)).toHaveCount(2);
    const texts = (await adjustmentCards(page).allInnerTexts()).map(flat).join(" | ");
    expect(texts).toContain(`Banco ${STAMP}`);
    expect(texts).toContain("+$ 12.000");
    expect(texts).toContain("−$ 8.000");
    await expect(page.getByRole("link", { name: scope.categoryName })).toHaveCount(0);
    await expect(page.getByRole("link", { name: incomeCategoryName })).toHaveCount(0);
  });

  test("at 360 px five rows hold: no sideways scroll, each at least 44 px tall @mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stacked control is the phone's");
    // Kills: the primitive's 44 px floor removed.
    await page.goto("/es/movements");
    await expect(typeRadios(page)).toHaveCount(5);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const radio of await typeRadios(page).all()) {
      const box = await radio.boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("a wide amount on a narrow phone", () => {
  const LONG_DESCRIPTION = "Compra en Amazon de electrodomésticos importados";

  // After the outer `beforeEach`, which resets the ledger and seeds its two rows.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        with movement as (
          insert into transactions (from_account_id, amount_cents, occurred_at, description)
          values (${scope.accountId}, 123456789012, ${todayInBogota()}, ${LONG_DESCRIPTION})
          returning id)
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        select id, ${scope.categoryId}, 123456789012 from movement`;
    });
  });

  test("keeps the title at least 7rem wide and the amount inside the row @mobile", async ({
    page,
  }) => {
    await page.goto("/es/movements");

    const title = page.getByText(LONG_DESCRIPTION, { exact: true }).filter({ visible: true });
    const amount = page.getByText(/1\.234\.567\.890/).filter({ visible: true });
    await expect(title).toBeVisible();
    await expect(amount).toBeVisible();

    expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(MIN_TITLE_PX);
    const card = page.locator(".rt-Card").filter({ visible: true }).filter({ has: title }).last();
    expect(await rightOverhang(amount, card)).toBeLessThanOrEqual(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});

// RF-198: the search runs in Postgres over the description and, for a figure, the amount; the
// field sits in both shapes, so the visible one is the one typed into.
test("searches by description or amount and clears with the filters", async ({ page }, testInfo) => {
  const desktop = testInfo.project.name === "desktop";
  const ledger = page.getByRole("table", { name: transactions.listTitle });
  const rowFor = (category: string) =>
    desktop
      ? ledger.getByText(category, { exact: true })
      : page.getByRole("link", { name: category });
  const field = page
    .getByRole("searchbox", { name: transactions.searchLabel, exact: true })
    .filter({ visible: true });

  await page.goto("/es/movements");
  await expect(rowFor(scope.categoryName)).toBeVisible();

  // A fill made before the page hydrates is wiped by it, so the first one is retried until it lands.
  await expect(async () => {
    await field.fill("harness gasto");
    await expect(page).toHaveURL(/\/es\/movements\?q=harness(\+|%20)gasto$/, { timeout: 2000 });
  }).toPass();
  await expect(rowFor(scope.categoryName)).toBeVisible();
  await expect(rowFor(incomeCategoryName)).toHaveCount(0);

  await field.fill(String(INCOME_CENTS / 100));
  await expect(page).toHaveURL(/q=71000/);
  await expect(rowFor(incomeCategoryName)).toBeVisible();
  await expect(rowFor(scope.categoryName)).toHaveCount(0);

  await field.fill("");
  await expect(page).toHaveURL("/es/movements");
  await expect(rowFor(scope.categoryName)).toBeVisible();
  await expect(rowFor(incomeCategoryName)).toBeVisible();
});
