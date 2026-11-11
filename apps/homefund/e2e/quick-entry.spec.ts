/**
 * Quick entry, the make-or-break path (RF-22): one field the interpreter reads
 * into an editable expense. The interpretation runs in the browser and nowhere
 * else, so no headless check can see the amount and the category land in the
 * fields a person is about to save.
 */
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { clearLedger, readScope, test } from "./global-setup";

const transactions = messages.transactions;
const scope = readScope();

// The category is named in the text, so the interpreter matches it by name and
// the amount is what is left; 45.910 pesos is 4.591.000 cents.
const AMOUNT_PESOS = "45910";
// The field groups thousands as they are written into it.
const AMOUNT_SHOWN = "45.910";
const AMOUNT_CENTS = 4591000;

test.beforeEach(async () => {
  await clearLedger();
});

test.afterEach(async () => {
  await clearLedger();
});

test("reads the amount and the category out of one line and records the movement", async ({
  page,
}) => {
  await page.goto("/es");

  // The dashboard's one tap into the sheet: the pill reads like the field it raises.
  const pill = page.getByRole("button", { name: transactions.quickPlaceholder, exact: true });
  await pill.click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  // Escape gives focus back to the pill that raised the sheet, then reopens it.
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(pill).toBeFocused();
  await pill.click();
  await expect(sheet).toBeVisible();

  await sheet
    .getByRole("textbox", { name: transactions.quickTitle, exact: true })
    .fill(`${scope.categoryName} ${AMOUNT_PESOS}`);

  // Both proposals land in fields, editable. Two of them carry the amount: the
  // movement's own and the lone split's, which the sheet keeps equal to it (RF-69).
  // A split row names itself by its position, so the two answer to two names.
  await expect(
    sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true }),
  ).toHaveValue(AMOUNT_SHOWN);
  await expect(
    sheet.getByRole("button", { name: scope.categoryName, exact: true, pressed: true }),
  ).toBeVisible();

  // Nothing has been recorded yet, so the account has no last-used to fall back
  // on and the source is picked by hand.
  await sheet
    .getByRole("combobox", { name: transactions.accountLabel, exact: true })
    .click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();

  await sheet
    .getByRole("button", { name: transactions.quickSave, exact: true })
    .click();
  await expect(sheet).toBeHidden();

  const movements = await fixtureSql<
    {
      id: string;
      amount_cents: string;
      from_account_id: string | null;
      to_account_id: string | null;
      amount_from_words: boolean;
    }[]
  >`
    select id, amount_cents::text as amount_cents, from_account_id, to_account_id, amount_from_words
    from transactions
    where owner_user_id = ${scope.userId}`;
  expect(movements).toHaveLength(1);
  expect(movements[0].amount_cents).toBe(String(AMOUNT_CENTS));
  // A source and no destination: the sheet only ever writes an expense (RF-18).
  expect(movements[0].from_account_id).toBe(scope.accountId);
  expect(movements[0].to_account_id).toBeNull();
  // Digits alone are no reading of words: «Revisar el mes» has nothing to ask (RF-155).
  expect(movements[0].amount_from_words).toBe(false);

  const splits = await fixtureSql<
    { category_id: string; amount_cents: string }[]
  >`
    select category_id, amount_cents::text as amount_cents
    from transaction_splits
    where transaction_id = ${movements[0].id}`;
  expect(splits).toHaveLength(1);
  expect(splits[0].category_id).toBe(scope.categoryId);
  expect(splits[0].amount_cents).toBe(String(AMOUNT_CENTS));
});

// The sheet fills the amount from what the interpreter proposes (RF-22), so the
// multiplier has to survive the trip from the text to the field and to the ledger.
test("«25 mil» proposes 25000 pesos and saving writes 2500000 cents", async ({ page }) => {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  await sheet
    .getByRole("textbox", { name: transactions.quickTitle, exact: true })
    .fill(`${scope.categoryName} 25 mil`);
  await expect(
    sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true }),
  ).toHaveValue("25.000");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();
  await expect(sheet).toBeHidden();

  const rows = await fixtureSql<{ amount_cents: string; amount_from_words: boolean }[]>`
    select amount_cents::text as amount_cents, amount_from_words from transactions
    where owner_user_id = ${scope.userId}`;
  // Read from words, so «Revisar el mes» asks about it (RF-155).
  expect(rows).toEqual([{ amount_cents: "2500000", amount_from_words: true }]);
});

// M71 (Q12-e, Q12-f). An «m» with words after it is not guessed: the sheet asks
// which amount the person meant (boards C3m, C3n). The wording is the board's.
const ASK_HINT = "Elige cuánto es, o escribe el monto.";
const ASK_TEXT = "3 M arriendo";
const askQuestion = "¿Cuánto es «3 M»?";

async function openSheet(page: import("@playwright/test").Page) {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return {
    sheet,
    quick: sheet.getByRole("textbox", { name: transactions.quickTitle, exact: true }),
    amount: sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true }),
    save: sheet.getByRole("button", { name: transactions.quickSave, exact: true }),
    group: sheet.getByRole("radiogroup", { name: askQuestion, exact: true }),
  };
}

async function pickAccount(
  page: import("@playwright/test").Page,
  sheet: import("@playwright/test").Locator,
) {
  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
}

async function storedAmounts() {
  const rows = await fixtureSql<{ amount_cents: string }[]>`
    select amount_cents::text as amount_cents from transactions
    where owner_user_id = ${scope.userId}`;
  return rows.map((row) => row.amount_cents);
}

async function storedFromWords() {
  const rows = await fixtureSql<{ amount_from_words: boolean }[]>`
    select amount_from_words from transactions where owner_user_id = ${scope.userId}`;
  return rows.map((row) => row.amount_from_words);
}

test("picking «$ 3.000.000» fills the amount and saving stores 3.000.000 pesos (C3n)", async ({
  page,
}) => {
  const { sheet, quick, amount, save, group } = await openSheet(page);
  await quick.pressSequentially(`${scope.categoryName} ${ASK_TEXT}`);
  await group.getByRole("radio", { name: "$ 3.000.000", exact: true }).check();

  await expect(group.getByRole("radio", { name: "$ 3.000.000", exact: true })).toBeChecked();
  await expect(group.getByRole("radio", { name: "$ 3", exact: true })).not.toBeChecked();
  await expect(amount).toHaveValue("3.000.000");
  await expect(sheet.getByText(transactions.quickInterpreted, { exact: true })).toBeVisible();
  await expect(sheet.getByText(ASK_HINT, { exact: true })).toBeHidden();
  await expect(save).toBeEnabled();

  await pickAccount(page, sheet);
  await save.click();
  await expect(sheet).toBeHidden();
  expect(await storedAmounts()).toEqual(["300000000"]);
  // The million is the multiplied reading of «M»: «Revisar el mes» asks about it (RF-155).
  expect(await storedFromWords()).toEqual([true]);
});

test.describe("at 360 wide", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the question and its two radios cause no horizontal overflow @mobile", async ({ page }) => {
    const { sheet, quick, group } = await openSheet(page);
    await quick.pressSequentially(`${scope.categoryName} ${ASK_TEXT}`);
    await expect(group).toBeVisible();

    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return {
        page: document.documentElement.scrollWidth > window.innerWidth,
        dialog: dialog ? dialog.scrollWidth > dialog.clientWidth + 1 : null,
      };
    });
    expect(overflow).toEqual({ page: false, dialog: false });

    const box = await group.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    await expect(sheet).toBeVisible();
  });
});
