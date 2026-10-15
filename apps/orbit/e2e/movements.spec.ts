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
          ${accountId}, ${scope.userId}, ${accountName}, 'asset', 'bancaria',
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
