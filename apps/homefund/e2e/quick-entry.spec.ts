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
  ).toHaveValue(AMOUNT_PESOS);
  await expect(
    sheet.getByRole("textbox", {
      name: transactions.splitRowAmount.replace("{position}", "1"),
      exact: true,
    }),
  ).toHaveValue(AMOUNT_PESOS);
  await expect(
    sheet.getByRole("combobox", {
      name: transactions.splitRowCategory.replace("{position}", "1"),
      exact: true,
    }),
  ).toHaveText(scope.categoryName);

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
    }[]
  >`
    select id, amount_cents::text as amount_cents, from_account_id, to_account_id
    from transactions
    where owner_user_id = ${scope.userId}`;
  expect(movements).toHaveLength(1);
  expect(movements[0].amount_cents).toBe(String(AMOUNT_CENTS));
  // A source and no destination: the sheet only ever writes an expense (RF-18).
  expect(movements[0].from_account_id).toBe(scope.accountId);
  expect(movements[0].to_account_id).toBeNull();

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
  ).toHaveValue("25000");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();
  await expect(sheet).toBeHidden();

  const rows = await fixtureSql<{ amount_cents: string }[]>`
    select amount_cents::text as amount_cents from transactions
    where owner_user_id = ${scope.userId}`;
  expect(rows).toEqual([{ amount_cents: "2500000" }]);
});

test("«1.500 mil» proposes no amount and the sheet refuses to save", async ({ page }) => {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  await sheet
    .getByRole("textbox", { name: transactions.quickTitle, exact: true })
    .fill(`${scope.categoryName} 1.500 mil`);
  await expect(
    sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true }),
  ).toHaveValue("");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();

  await expect(sheet.getByText(transactions.errors.amountRequired, { exact: true })).toBeVisible();
  const rows = await fixtureSql<{ id: string }[]>`
    select id from transactions where owner_user_id = ${scope.userId}`;
  expect(rows).toEqual([]);
});

// Typed one key at a time, every prefix is read: «1.500» proposes 1500 and
// «25 m» a million times 25 on the way. The field follows the latest reading,
// so neither may survive the text that proposed it.
test("typing «1.500 mil» key by key takes back the 1500 the prefix proposed", async ({
  page,
}) => {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  const quick = sheet.getByRole("textbox", { name: transactions.quickTitle, exact: true });
  const amount = sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true });

  await quick.pressSequentially(`${scope.categoryName} 1.500`);
  await expect(amount).toHaveValue("1500");
  await quick.pressSequentially(" mil");
  await expect(amount).toHaveValue("");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();

  await expect(sheet.getByText(transactions.errors.amountRequired, { exact: true })).toBeVisible();
  const rows = await fixtureSql<{ id: string }[]>`
    select id from transactions where owner_user_id = ${scope.userId}`;
  expect(rows).toEqual([]);
});

test("typing «25 m» then «il» key by key leaves 25000, not 25000000", async ({ page }) => {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  const quick = sheet.getByRole("textbox", { name: transactions.quickTitle, exact: true });
  const amount = sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true });

  await quick.pressSequentially(`${scope.categoryName} 25 m`);
  await expect(amount).toHaveValue("25000000");
  await quick.pressSequentially("il");
  await expect(amount).toHaveValue("25000");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();
  await expect(sheet).toBeHidden();

  const rows = await fixtureSql<{ amount_cents: string }[]>`
    select amount_cents::text as amount_cents from transactions
    where owner_user_id = ${scope.userId}`;
  expect(rows).toEqual([{ amount_cents: "2500000" }]);
});

test("an amount typed by hand survives further text that proposes none", async ({ page }) => {
  await page.goto("/es");
  await page.getByRole("button", { name: transactions.quickPlaceholder, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();

  const quick = sheet.getByRole("textbox", { name: transactions.quickTitle, exact: true });
  const amount = sheet.getByRole("textbox", { name: transactions.amountLabel, exact: true });

  // The parser writes 1500, the person replaces it, and the reading that then
  // proposes nothing takes back only what the parser wrote.
  await quick.pressSequentially(`${scope.categoryName} 1.500`);
  await expect(amount).toHaveValue("1500");
  await amount.fill("9000");
  // Back in the text, the caret starts at the front; the «m» goes at the end.
  await quick.press("End");
  await quick.press("m");
  await expect(quick).toHaveValue(`${scope.categoryName} 1.500m`);
  await expect(amount).toHaveValue("9000");

  await sheet.getByRole("combobox", { name: transactions.accountLabel, exact: true }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await sheet.getByRole("button", { name: transactions.quickSave, exact: true }).click();
  await expect(sheet).toBeHidden();

  const rows = await fixtureSql<{ amount_cents: string }[]>`
    select amount_cents::text as amount_cents from transactions
    where owner_user_id = ${scope.userId}`;
  expect(rows).toEqual([{ amount_cents: "900000" }]);
});
