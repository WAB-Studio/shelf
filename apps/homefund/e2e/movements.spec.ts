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
import { asHarnessUser, clearGroup, clearLedger, readScope, seedGroup, test } from "./global-setup";

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

test("the edit dialog titles itself for editing, not for a new movement (D12)", async ({
  page,
}, testInfo) => {
  // The row menu this drives is the laptop band's. The phone reaches the same
  // edit dialog from the movement's own detail page, which is a second entry
  // and a second test; `loading.tsx` no longer stands in the way of it.
  test.skip(testInfo.project.name !== "desktop", "the row menu is the laptop's");

  await page.goto("/es/movements");
  await page
    .getByRole("button", {
      name: common.actionsFor.replace("{name}", EXPENSE_DESCRIPTION),
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: transactions.edit, exact: true }).click();

  // The dialog's own `Dialog.Title` repeats the same string for the a11y tree:
  // `VisuallyHidden` clips it to a pixel rather than dropping it, so it still
  // counts as visible and `.filter({ visible: true })` cannot tell the two
  // apart. The form's own heading is the only one inside the `<form>`.
  const formHeading = page
    .locator("form")
    .getByRole("heading", { name: transactions.editTitle, exact: true });
  await expect(formHeading).toBeVisible();
  await expect(
    page.getByRole("heading", { name: transactions.formTitle, exact: true }),
  ).toHaveCount(0);
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
  const MINUS = "−";
  const BASE_STAMP = randomUUID().slice(0, 8);
  const REC_DAY = addCivilDays(todayInBogota(), -1);
  const OPENING = 50_000_000; // $ 500.000
  const errorsText = messages.errors;

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

  test("a negative adjustment reads −$ 8.000 in the list", async ({ page }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    await seedAdjustment(-800_000);

    await page.goto("/es/movements");

    const row = adjustmentRow(page, desktop);
    await expect(row).toHaveCount(1);
    const text = flat(await row.innerText());
    expect(text).toContain(transactions.kindAdjustment);
    expect(text).toContain(accountName);
    expect(text).toContain(`${MINUS}$ 8.000`);
    expect(text).not.toContain("+$");
  });

  test("on the laptop's table the adjustment's category cell is empty and its amount signed", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the table is the laptop's");
    await seedAdjustment(1_200_000);

    await page.goto("/es/movements");

    const ledger = page.getByRole("table", { name: transactions.listTitle });
    const headers = await ledger.getByRole("row").first().locator(":scope > *").allInnerTexts();
    const categoryAt = headers.findIndex(
      (h) => flat(h).toLowerCase() === transactions.categoryLabel.toLowerCase(),
    );
    expect(categoryAt).toBeGreaterThanOrEqual(0);

    const row = ledger.getByRole("row").filter({ hasText: transactions.kindAdjustment });
    await expect(row).toHaveCount(1);
    const cells = await row.getByRole("cell").allInnerTexts();
    // The table's own «—» for a row with no category, as a transfer shows it
    // (changed by ruling of the main session).
    expect(flat(cells[categoryAt] ?? "x")).toBe("—");
    expect(flat(cells.join(" | "))).toContain("+$ 12.000");
    // B10: an adjustment is never editable, so its row carries no menu.
    await expect(
      page.getByRole("button", {
        name: common.actionsFor.replace("{name}", transactions.kindAdjustment),
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("the list's net is income minus expense of the ordinary rows, the adjustment left out", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the net sits in the laptop's header");
    await seedAdjustment(1_200_000);

    await page.goto("/es/movements");

    // Seeded: income $ 71.000, expense $ 32.000. Counting the +$ 12.000 as
    // income reads $ 51.000; as an expense, $ 27.000.
    const meta = page.getByText(/· neto/).filter({ visible: true }).first();
    const text = flat(await meta.innerText());
    expect(text).toContain("+$ 39.000");
    expect(text).not.toContain("51.000");
    expect(text).not.toContain("27.000");
  });

  test("ordinary rows keep their category and sign beside an adjustment", async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    await seedAdjustment(1_200_000);

    await page.goto("/es/movements");

    const rowFor = (category: string) =>
      desktop
        ? page
            .getByRole("table", { name: transactions.listTitle })
            .getByRole("row")
            .filter({ hasText: category })
        : page.getByRole("link").filter({ hasText: category });

    const expense = flat(await rowFor(scope.categoryName).innerText());
    expect(expense).toContain(`${MINUS}$ 32.000`);
    expect(expense).not.toContain(transactions.kindAdjustment);

    const income = flat(await rowFor(incomeCategoryName).innerText());
    expect(income).toContain("+$ 71.000");
    expect(income).not.toContain(transactions.kindAdjustment);
  });

  test("the dashboard's recent lines read «Descuadre» and +$ 12.000", async ({ page }) => {
    await seedAdjustment(1_200_000);

    await page.goto("/es");

    const line = page
      .getByRole("link")
      .filter({ hasText: transactions.kindAdjustment })
      .filter({ visible: true });
    await expect(line).toHaveCount(1);
    const text = flat(await line.innerText());
    expect(text).toContain(accountName);
    expect(text).toContain("+$ 12.000");
    expect(text).not.toContain(transactions.kindIncome);
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

  test("a positive adjustment's detail carries no expense caption", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the caption is the laptop's detail");
    await seedAdjustment(1_200_000);

    await page.goto(`/es/movements/${adjustmentId}`);
    await expect(
      page
        .getByRole("heading", { name: transactions.kindAdjustment, exact: true })
        .filter({ visible: true }),
    ).toHaveCount(1);

    const body = flat(await page.locator("main").innerText());
    expect(body).toContain("+$ 12.000");
    expect(body).not.toContain("deducido");
  });

  // The phone's dashboard list and its detail page are siblings of the laptop's, each deciding
  // sign and actions on its own. The laptop project reaches them by narrowing the window, so a
  // run of this project alone still drives them.
  test.describe("on a phone-wide window", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the dashboard's recent lines sign a positive and a negative adjustment by their legs", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the mobile project already runs narrow");
      await seedAdjustment(1_200_000);
      await page.goto("/es");
      const up = page
        .getByRole("link")
        .filter({ hasText: transactions.kindAdjustment })
        .filter({ visible: true });
      await expect(up).toHaveCount(1);
      const upText = flat(await up.innerText());
      expect(upText).toContain("+$ 12.000");
      expect(upText).not.toContain(MINUS);

      await fixtureSql`
        delete from transactions
        where from_account_id = ${accountId} or to_account_id = ${accountId}`;
      await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
      await fixtureSql`delete from accounts where id = ${accountId}`;
      await seedAdjustment(-800_000);
      await page.goto("/es");
      const down = page
        .getByRole("link")
        .filter({ hasText: transactions.kindAdjustment })
        .filter({ visible: true });
      await expect(down).toHaveCount(1);
      const downText = flat(await down.innerText());
      expect(downText).toContain(`${MINUS}$ 8.000`);
      expect(downText).not.toContain("+$");
    });

    test("the detail offers no Editar and no Eliminar on an adjustment, and says how to fix it", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the mobile project already runs narrow");
      await seedAdjustment(1_200_000);
      await page.goto(`/es/movements/${adjustmentId}`);

      await expect(
        page.getByText(transactions.adjustmentFix, { exact: true }).filter({ visible: true }),
      ).toHaveCount(1);
      await expect(page.getByRole("button", { name: transactions.edit, exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: transactions.delete, exact: true }),
      ).toHaveCount(0);
    });
  });

  test("a forged delete of the adjustment surfaces the read-only refusal and deletes nothing", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the row menu is the laptop's");
    await seedAdjustment(1_200_000);

    // The interface offers no way to delete an adjustment, so the delete of an
    // ordinary row is sent with the adjustment's id swapped in.
    const [expense] = await fixtureSql<{ id: string }[]>`
      select id from transactions
      where owner_user_id = ${scope.userId} and description = ${EXPENSE_DESCRIPTION}`;
    let forged = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (
        request.method() === "POST" &&
        request.headers()["next-action"] &&
        body?.includes(expense.id)
      ) {
        forged += 1;
        await route.continue({ postData: body.replaceAll(expense.id, adjustmentId) });
        return;
      }
      await route.continue();
    });

    await page.goto("/es/movements");
    await page
      .getByRole("button", {
        name: common.actionsFor.replace("{name}", EXPENSE_DESCRIPTION),
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: transactions.delete, exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: transactions.delete, exact: true })
      .click();

    await expect(page.getByText(errorsText.adjustmentReadOnly)).toBeVisible();
    expect(forged).toBe(1);
    const [left] = await fixtureSql<{ n: string }[]>`
      select count(*)::text as n from transactions where id in (${adjustmentId}, ${expense.id})`;
    expect(left.n).toBe("2");
  });

  test("a forged edit of the adjustment that carries its own current stamp is refused read-only and writes nothing", async ({
    page,
  }, testInfo) => {
    // Kills: the `adjustment` refusal removed from the update action (a stamp that
    // matches cannot be answered `stale`, so only that refusal can be heard).
    test.skip(testInfo.project.name !== "desktop", "the row menu is the laptop's");
    await seedAdjustment(1_200_000);
    const [before] = await fixtureSql<{ stamp: string; amount: string }[]>`
      select updated_at::text as stamp, amount_cents::text as amount from transactions where id = ${adjustmentId}`;

    const [expense] = await fixtureSql<{ id: string }[]>`
      select id from transactions
      where owner_user_id = ${scope.userId} and description = ${EXPENSE_DESCRIPTION}`;
    const forgedBodies: Record<string, unknown>[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() === "POST" && request.headers()["next-action"] && body?.includes(expense.id)) {
        const [input] = JSON.parse(body) as Record<string, unknown>[];
        const forged = { ...input, transactionId: adjustmentId, expectedUpdatedAt: before.stamp };
        forgedBodies.push(forged);
        await route.continue({ postData: JSON.stringify([forged]) });
        return;
      }
      await route.continue();
    });

    await page.goto("/es/movements");
    await page
      .getByRole("button", {
        name: common.actionsFor.replace("{name}", EXPENSE_DESCRIPTION),
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: transactions.edit, exact: true }).click();
    await page.getByLabel(transactions.amountLabel, { exact: true }).fill("99999");
    await page
      .locator("form")
      .getByRole("button", { name: transactions.saveMovement, exact: true })
      .click();

    await expect(page.getByText(errorsText.adjustmentReadOnly)).toBeVisible();
    await expect(page.getByText(errorsText.stale)).toHaveCount(0);
    expect(forgedBodies).toHaveLength(1);
    expect(forgedBodies[0].transactionId).toBe(adjustmentId);
    expect(forgedBodies[0].expectedUpdatedAt).toBe(before.stamp);
    const [after] = await fixtureSql<{ stamp: string; amount: string }[]>`
      select updated_at::text as stamp, amount_cents::text as amount from transactions where id = ${adjustmentId}`;
    expect(after).toEqual(before);
  });

  test("a forged edit of the adjustment surfaces the read-only refusal, not a saved dialog", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the row menu is the laptop's");
    await seedAdjustment(1_200_000);

    // The interface offers no way to edit an adjustment, so the edit of an
    // ordinary row is sent with the adjustment's id swapped in.
    const [expense] = await fixtureSql<{ id: string }[]>`
      select id from transactions
      where owner_user_id = ${scope.userId} and description = ${EXPENSE_DESCRIPTION}`;
    let forged = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (
        request.method() === "POST" &&
        request.headers()["next-action"] &&
        body?.includes(expense.id)
      ) {
        forged += 1;
        await route.continue({ postData: body.replaceAll(expense.id, adjustmentId) });
        return;
      }
      await route.continue();
    });

    await page.goto("/es/movements");
    await page
      .getByRole("button", {
        name: common.actionsFor.replace("{name}", EXPENSE_DESCRIPTION),
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: transactions.edit, exact: true }).click();
    await page.getByLabel(transactions.amountLabel, { exact: true }).fill("99999");
    await page
      .locator("form")
      .getByRole("button", { name: transactions.saveMovement, exact: true })
      .click();

    await expect(page.getByText(errorsText.adjustmentReadOnly)).toBeVisible();
    expect(forged).toBe(1);
    // A saved edit closes the dialog; a refused one leaves it open.
    await expect(page.getByRole("dialog")).toBeVisible();
    const [kept] = await fixtureSql<{ amount: string }[]>`
      select amount_cents::text as amount from transactions where id = ${adjustmentId}`;
    expect(kept.amount).toBe("1200000");
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
  const metaOf = (page: import("@playwright/test").Page, pattern: RegExp) =>
    page.getByText(pattern).filter({ visible: true }).first();

  test("the phone offers five types in order, Descuadre last (C2a)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stacked control is the phone's");
    // Kills: the fifth item omitted.
    await page.goto("/es/movements");
    await expect(typeRadios(page)).toHaveCount(TYPE_ORDER.length);
    for (const [index, name] of TYPE_ORDER.entries()) {
      await expect(typeRadios(page).nth(index)).toHaveAccessibleName(name);
    }
  });

  test("picking Descuadre on the phone narrows to the two adjustments (C2b)", async ({ page }, testInfo) => {
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

  test("on the laptop the select, the chip and the rows say Descuadre (C2d)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the select and the chip are the laptop's");
    // Kills: `types` left at four (the select is blank, the chip reads «adjustment»).
    await page.goto("/es/movements?type=adjustment");

    await expect(
      page.getByLabel(transactions.typeLabel, { exact: true }).filter({ visible: true }),
    ).toContainText(DESCUADRE);
    await expect(
      page.getByRole("button", {
        name: common.removeFilter.replace("{label}", DESCUADRE),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("table", { name: transactions.listTitle })
        .getByRole("row")
        .filter({ hasText: `Banco ${STAMP}` }),
    ).toHaveCount(2);
  });

  test("under Descuadre the laptop's meta counts the adjustments and drops the net", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the meta is the laptop's");
    // Kills: `listMeta` and the nets kept for every type.
    await page.goto("/es/movements?type=adjustment");

    const meta = metaOf(page, /descuadres/);
    await expect(meta).toBeVisible();
    const text = flat(await meta.innerText());
    expect(text).toContain("2 descuadres");
    expect(text).not.toContain("$");
    expect(text).not.toContain("neto");
  });

  test("one adjustment reads in the singular", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the meta is the laptop's");
    // Kills: the plural branch dropped (always «descuadres»).
    await fixtureSql`
      delete from transactions
      where reconciliation_id is not null and from_account_id = ${accountId}`;
    await page.goto("/es/movements?type=adjustment");

    const meta = metaOf(page, /1 descuadre/);
    await expect(meta).toBeVisible();
    expect(flat(await meta.innerText())).not.toContain("descuadres");
  });

  test("every other type keeps the count and the net", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the meta is the laptop's");
    // Kills: the count-only meta applied to every type but «all».
    await page.goto("/es/movements?type=expense");

    const meta = metaOf(page, /· neto/);
    await expect(meta).toBeVisible();
    const text = flat(await meta.innerText());
    expect(text).toContain("1 · neto");
    expect(text).toContain("−$ 32.000");
    expect(text).not.toContain("descuadre");
  });

  test("no adjustment: the filtered-empty state offers Quitar filtros, which returns to Todos (C2c)", async ({
    page,
  }) => {
    // Kills: the first-run empty state shown under a filter; the clear that
    // leaves `type` in the URL.
    await page.goto(`/es/movements?type=adjustment&account=${scope.accountId}`);

    await expect(
      page.getByText(transactions.filteredEmptyTitle, { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page
        .getByText(transactions.filteredEmptyDescription, { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: transactions.clearFilters, exact: true })
      .filter({ visible: true })
      .click();

    await expect(page).toHaveURL("/es/movements");
  });

  test("removing the Descuadre chip returns to every type", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the chip is the laptop's");
    // Kills: the chip clearing to «expense» instead of dropping the key.
    await page.goto("/es/movements?type=adjustment");
    await page
      .getByRole("button", {
        name: common.removeFilter.replace("{label}", DESCUADRE),
        exact: true,
      })
      .click();

    await expect(page).toHaveURL("/es/movements");
    const ledger = page.getByRole("table", { name: transactions.listTitle });
    await expect(ledger.getByText(scope.categoryName, { exact: true })).toBeVisible();
    await expect(ledger.getByRole("row").filter({ hasText: `Banco ${STAMP}` })).toHaveCount(2);
  });

  test("an unknown type reads Todos on the phone", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the stacked control is the phone's");
    // Kills: the unknown value passed through to the control (nothing checked).
    await page.goto("/es/movements?type=Adjustment");

    await expect(
      page.getByRole("radio", { name: transactions.filterAll, exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("radio", { name: DESCUADRE, exact: true }),
    ).not.toBeChecked();
  });

  test("at 360 px five rows hold: no sideways scroll, each at least 44 px tall", async ({ page }, testInfo) => {
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

  test.describe("at 768 px (C2e)", () => {
    test.use({ viewport: { width: 768, height: 900 } });

    test("the five options lie in one row and every label is whole", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "the phone band is the mobile project's");
      // Kills: the options' `min-width: max-content` returning with five labels.
      await page.goto("/es/movements");
      await expect(typeRadios(page)).toHaveCount(5);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      const radios = await typeRadios(page).all();
      const tops = [];
      for (const radio of radios) tops.push((await radio.boundingBox())!.y);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4);

      const clipped = await typeRadios(page).evaluateAll((nodes) =>
        nodes.flatMap((node) =>
          [node, ...node.querySelectorAll("*")]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => `${el.tagName}.${el.className}`),
        ),
      );
      expect(clipped).toEqual([]);
      const right = await typeRadios(page).last().evaluate((el) => el.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(768);
    });
  });
});

// RF-140 (board C3a): the ledger names a fund category «{nombre} · fondo» and a
// personal one bare. The person holds both under one name, so only the mark
// tells the two apart.
test.describe("a category of the fund among the movements (RF-140, board C3a)", () => {
  const STAMP = randomUUID().slice(0, 8);
  const NAME = `T4 Mercado ${STAMP}`;
  const MARKED = `${NAME} · fondo`;
  const ids = {
    account: randomUUID(),
    fund: randomUUID(),
    own: randomUUID(),
  };

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${ids.account}, ${groupId}, true, ${`Cuenta del fondo ${STAMP}`}, 'asset', 'bank',
          0, '2026-01-01')`;
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${ids.fund}, ${groupId}, ${NAME}, 'expense', '#8C4A4A')`;
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${ids.own}, ${scope.userId}, ${NAME}, 'expense', '#4C8C4A')`;
      for (const [account, category, cents] of [
        [ids.account, ids.fund, 4_500_000],
        [scope.accountId, ids.own, 1_100_000],
      ] as const) {
        const [movement] = await tx<{ id: string }[]>`
          insert into transactions (from_account_id, amount_cents, occurred_at)
          values (${account}, ${cents}, (now() at time zone ${TIME_ZONE})::date)
          returning id`;
        await tx`
          insert into transaction_splits (transaction_id, category_id, amount_cents)
          values (${movement.id}, ${category}, ${cents})`;
      }
    });
  });

  test.afterEach(async () => {
    await fixtureSql`
      delete from transactions
      where id in (
        select transaction_id from transaction_splits where category_id in (${ids.fund}, ${ids.own}))`;
    await fixtureSql`delete from categories where id in (${ids.fund}, ${ids.own})`;
    await fixtureSql`delete from accounts where id = ${ids.account}`;
    await clearGroup();
  });

  const flat = (text: string) => text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

  // Every line a row draws, so a title is told from a longer one that contains it.
  async function rowLines(page: import("@playwright/test").Page, desktop: boolean) {
    const cells = desktop
      ? page.getByRole("table", { name: transactions.listTitle }).getByRole("cell")
      : page.getByRole("link").filter({ visible: true });
    const texts = await cells.allInnerTexts();
    return texts.flatMap((text) => text.split("\n").map(flat)).filter(Boolean);
  }

  test("the fund's movement reads «· fondo» and the personal one bare", async ({ page }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    // Kills: the names map built from bare names; every category marked.
    await page.goto("/es/movements");
    await expect(
      desktop
        ? page.getByRole("table", { name: transactions.listTitle }).getByText(NAME).first()
        : page.getByRole("link").filter({ hasText: NAME }).first(),
    ).toBeVisible();

    // A row with no description is titled by its category, so on the laptop the
    // title and the category cell both say it: the cell is counted alone.
    let lines: string[];
    if (desktop) {
      const table = page.getByRole("table", { name: transactions.listTitle });
      const headers = await table.getByRole("columnheader").allInnerTexts();
      const at = headers.findIndex((header) => flat(header).toLowerCase() === transactions.categoryLabel.toLowerCase());
      expect(at, JSON.stringify(headers)).toBeGreaterThanOrEqual(0);
      const rows = await table.getByRole("row").all();
      lines = [];
      for (const row of rows.slice(1)) {
        const cell = row.getByRole("cell").nth(at);
        if (await cell.count()) lines.push(flat(await cell.innerText()));
      }
      const all = await rowLines(page, true);
      expect(all.filter((line) => line === MARKED)).toHaveLength(2);
      expect(all.filter((line) => line === NAME)).toHaveLength(2);
    } else {
      lines = await rowLines(page, false);
    }
    expect(lines.filter((line) => line === MARKED)).toHaveLength(1);
    expect(lines.filter((line) => line === NAME)).toHaveLength(1);
    expect(lines.filter((line) => line.includes("· fondo") && line !== MARKED)).toEqual([]);
  });

  test("the category select offers the bare name and the marked one", async ({ page }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    // Kills: the select's list built bare (one option, or two alike).
    await page.goto("/es/movements");
    if (!desktop) {
      await page
        .getByRole("button", { name: transactions.filtersLabel, exact: true })
        .click();
    }
    await page
      .getByLabel(transactions.categoryLabel, { exact: true })
      .filter({ visible: true })
      .click();

    await expect(page.getByRole("option", { name: NAME, exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: MARKED, exact: true })).toHaveCount(1);
  });

  test("the category chip names the fund's scope", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the chip is the laptop's");
    // Kills: the chip resolved from a bare list.
    await page.goto(`/es/movements?category=${ids.fund}`);

    await expect(
      page.getByRole("button", {
        name: common.removeFilter.replace("{label}", MARKED),
        exact: true,
      }),
    ).toBeVisible();
  });

  test("the chip of the personal category stays bare", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the chip is the laptop's");
    // Kills: every category's chip marked.
    await page.goto(`/es/movements?category=${ids.own}`);

    await expect(
      page.getByRole("button", {
        name: common.removeFilter.replace("{label}", NAME),
        exact: true,
      }),
    ).toBeVisible();
  });
});
