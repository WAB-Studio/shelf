/**
 * A fund category reads `{name} · fondo` on a delivery's card and row, on a
 * webhook credential's row and in its issue dialog, and in this month's
 * expenses by category (RF-140, RF-34). The person holds a personal category
 * and the fund holds one of the same name; only the mark tells them apart.
 *
 * Every row is written under the harness identity and dropped by id; the
 * credential the dialog issues is dropped by its stamped name; the group goes
 * through `clearGroup`.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";
import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  clearGroup,
  clearLedger,
  clearQueue,
  readScope,
  seedGroup,
  seedQueue,
  test,
} from "./global-setup";

const webhooks = messages.webhooks;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const NAME = `T4 Mercado ${stamp}`;
// A fund category reads bare now (the user, 2026-10-30), so the fixture gives it a name of its own
// to tell the two scopes apart.
const MARKED = `${NAME} del fondo`;
const CREDENTIAL = `Credencial T4 ${stamp}`;
const MERCHANT = `Tienda T4 ${stamp}`;

// The fund's spend is the larger, so it sorts first.
const FUND_CENTS = 30_000_000;
const PERSONAL_CENTS = 12_000_000;

const ids = {
  fundAccount: randomUUID(),
  personalCategory: randomUUID(),
  fundCategory: randomUUID(),
};

// The digits of a rendered amount: separators and currency mark are `Intl`'s.
async function digitsOf(locator: Locator): Promise<string> {
  return ((await locator.innerText()).match(/\d/g) ?? []).join("");
}

function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The reports screen's bands sit directly under main.
function reportBand(page: Page): Locator {
  return page.locator("main > .rt-Box").filter({ visible: true });
}

function laptop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 1024;
}

test.beforeAll(async () => {
  const { groupId } = await seedGroup();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (
        id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.fundAccount}, ${groupId}, true, ${`Cuenta fondo ${stamp}`}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.personalCategory}, ${scope.userId}, ${NAME}, 'expense', '#4C8C4A')`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${ids.fundCategory}, ${groupId}, ${MARKED}, 'expense', '#8C4A4A')`;

    for (const [account, category, cents] of [
      [ids.fundAccount, ids.fundCategory, FUND_CENTS],
      [scope.accountId, ids.personalCategory, PERSONAL_CENTS],
    ] as const) {
      const [expense] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${account}, ${cents}, (now() at time zone ${TIME_ZONE})::date, ${`Gasto T4 ${stamp}`})
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${expense.id}, ${category}, ${cents})`;
    }
  });
});

test.afterAll(async () => {
  await clearQueue();
  await clearLedger();
  await fixtureSql`delete from transactions where description like ${`%${stamp}`}`;
  // The fund account's expense is the group's, not the harness user's: clearLedger misses it.
  await fixtureSql`delete from transactions where description = ${`Gasto T4 ${stamp}`}`;
  await fixtureSql`delete from webhook_credentials where name = ${CREDENTIAL}`;
  await fixtureSql`delete from categories where id in ${fixtureSql([ids.personalCategory, ids.fundCategory])}`;
  await fixtureSql`delete from accounts where id = ${ids.fundAccount}`;
  await clearGroup();
});

test.describe("inbox", () => {
  test.beforeEach(async () => {
    await seedQueue([
      {
        merchant: MERCHANT,
        amountCents: 45_000,
        accountId: ids.fundAccount,
        categoryId: ids.fundCategory,
        categorySource: "merchant",
      },
    ]);
  });

  test("the delivery proposing the fund's category reads it marked", async ({ page }) => {
    // Kills: the bare lookup kept in delivery-card (phone) or inbox-screen (laptop table).
    await page.goto("/es/inbox");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
    await expect(band(page).getByText(NAME, { exact: true })).toHaveCount(0);
    if (!laptop(page)) {
      await expect(
        band(page).getByText(messages.ingest.categoryFromMerchant, { exact: true }),
      ).toBeVisible();
    }
  });
});

test.describe("webhooks", () => {
  test("the issue dialog offers both categories apart and the row reads the marked one", async ({ page }) => {
    // Kills: the dialog's items or the row's line left bare.
    await page.goto("/es/settings/webhooks");
    await page.getByRole("button", { name: webhooks.add, exact: true }).first().click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: webhooks.nameLabel }).fill(CREDENTIAL);
    await dialog.getByRole("combobox", { name: webhooks.defaultCategoryLabel }).click();

    await expect(
      page.getByRole("option", { name: `${NAME} ${messages.categories.kindExpense}`, exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("option", { name: `${MARKED} ${messages.categories.kindExpense}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: webhooks.issue, exact: true }).click();
    await dialog.getByRole("button", { name: webhooks.tokenAcknowledge, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(band(page).getByText(CREDENTIAL, { exact: true })).toBeVisible();
    // The laptop's table names no defaults; the phone's card carries the line.
    if (!laptop(page)) {
      await expect(
        band(page).getByText(webhooks.defaultCategory.replace("{name}", MARKED), { exact: true }),
      ).toBeVisible();
    }

    await fixtureSql`delete from webhook_credentials where name = ${CREDENTIAL}`;
  });
});

test.describe("reports", () => {
  test("the two scopes are two rows, each with its own figure, the larger first", async ({ page }) => {
    // Kills: row.name written bare (two alike rows); the order or the totals disturbed.
    await page.goto("/es/reports");

    const shown = reportBand(page);
    const fundRow = shown.getByText(MARKED, { exact: true }).locator("..");
    const personalRow = shown.getByText(NAME, { exact: true }).locator("..");

    await expect(fundRow).toHaveCount(1);
    await expect(personalRow).toHaveCount(1);
    expect(await digitsOf(fundRow)).toContain(String(FUND_CENTS / 100));
    expect(await digitsOf(personalRow)).toContain(String(PERSONAL_CENTS / 100));
    await expect(shown.getByText(new RegExp(NAME)).first()).toHaveText(MARKED);
  });
});

// ---------------------------------------------------------------------------
// RF-140, RF-86, RF-90: once an account is picked, only its scope's categories
// are offered or submitted. The fund holds «NAME · fondo», the person «NAME».
// ---------------------------------------------------------------------------

const PERSONAL_OPTION = `${NAME} ${messages.categories.kindExpense}`;
const FUND_OPTION = `${MARKED} ${messages.categories.kindExpense}`;
const FUND_ACCOUNT_NAME = `Cuenta fondo ${stamp}`;
const MATCH = `Tienda fondo ${stamp}`;
const MISMATCH = `Tienda cruzada ${stamp}`;

const matching = {
  merchant: MATCH,
  amountCents: 45_000,
  accountId: ids.fundAccount,
  categoryId: ids.fundCategory,
  categorySource: "merchant" as const,
};
// A personal account proposed with the fund's category: the other scope's.
const crossed = {
  merchant: MISMATCH,
  amountCents: 45_000,
  accountId: scope.accountId,
  categoryId: ids.fundCategory,
  categorySource: "merchant" as const,
};

// The flight answer carries the refreshed page too; the action's own result is the line holding `data`, `serverError` or `validationErrors`.
function actionResult(flight: string): string {
  const line = flight.split("\n").find((candidate) => /^\w+:\{"(data|serverError|validationErrors)"/.test(candidate));
  expect(line, "the answer carries no action result").toBeDefined();
  return line ?? "";
}

async function openCredentialDialog(page: Page): Promise<Locator> {
  await page.goto("/es/settings/webhooks");
  await page.getByRole("button", { name: webhooks.add, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: webhooks.nameLabel }).fill(CREDENTIAL);
  return dialog;
}

async function pickAccount(page: Page, dialog: Locator, name: string) {
  await dialog.getByRole("combobox", { name: webhooks.defaultAccountLabel }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function openCategories(page: Page, dialog: Locator) {
  await dialog.getByRole("combobox", { name: webhooks.defaultCategoryLabel }).click();
  await expect(page.getByRole("option", { name: webhooks.defaultNone, exact: true })).toBeVisible();
}

function optionCount(page: Page, name: string) {
  return page.getByRole("option", { name, exact: true });
}

test.describe("a credential's default category follows its default account", () => {
  test.afterEach(async () => {
    await fixtureSql`delete from webhook_credentials where name like ${`${CREDENTIAL}%`}`;
  });

  test("with no account both scopes are offered", async ({ page }) => {
    // Kills: a filter that runs with no account picked.
    const dialog = await openCredentialDialog(page);
    await openCategories(page, dialog);

    await expect(optionCount(page, PERSONAL_OPTION)).toHaveCount(1);
    await expect(optionCount(page, FUND_OPTION)).toHaveCount(1);
  });

  test("a personal account offers no fund category", async ({ page }) => {
    // Kills: the account ignored.
    const dialog = await openCredentialDialog(page);
    await pickAccount(page, dialog, scope.accountName);
    await openCategories(page, dialog);

    await expect(optionCount(page, PERSONAL_OPTION)).toHaveCount(1);
    await expect(optionCount(page, FUND_OPTION)).toHaveCount(0);
  });

  test("a fund account offers no personal category", async ({ page }) => {
    // Kills: a filter that only ever drops the fund's categories.
    const dialog = await openCredentialDialog(page);
    await pickAccount(page, dialog, FUND_ACCOUNT_NAME);
    await openCategories(page, dialog);

    await expect(optionCount(page, FUND_OPTION)).toHaveCount(1);
    await expect(optionCount(page, PERSONAL_OPTION)).toHaveCount(0);
  });

  test("going back to no account offers both again", async ({ page }) => {
    // Kills: the scope kept after the account is cleared.
    const dialog = await openCredentialDialog(page);
    await pickAccount(page, dialog, scope.accountName);
    await pickAccount(page, dialog, webhooks.defaultNone);
    await openCategories(page, dialog);

    await expect(optionCount(page, FUND_OPTION)).toHaveCount(1);
    await expect(optionCount(page, PERSONAL_OPTION)).toHaveCount(1);
  });

  test("switching to a personal account drops the fund category already picked", async ({ page }) => {
    // Kills: the stranded category kept in the form.
    const dialog = await openCredentialDialog(page);
    await openCategories(page, dialog);
    await optionCount(page, FUND_OPTION).click();
    await expect(
      dialog.getByRole("combobox", { name: webhooks.defaultCategoryLabel }),
    ).toContainText(MARKED);

    await pickAccount(page, dialog, scope.accountName);
    await expect(
      dialog.getByRole("combobox", { name: webhooks.defaultCategoryLabel }),
    ).toHaveText(webhooks.defaultNone);

    await dialog.getByRole("button", { name: webhooks.issue, exact: true }).click();
    await dialog.getByRole("button", { name: webhooks.tokenAcknowledge, exact: true }).click();
    await expect(dialog).toBeHidden();

    const [stored] = await fixtureSql<{ default_account_id: string | null; default_category_id: string | null }[]>`
      select default_account_id, default_category_id from webhook_credentials where name = ${CREDENTIAL}`;
    expect(stored.default_account_id).toBe(scope.accountId);
    expect(stored.default_category_id).toBeNull();
  });

  test("a forged submission of the fund's category on a personal account is refused and stores nothing", async ({
    page,
  }, testInfo) => {
    // Kills: a server that trusts the form's filter.
    test.skip(testInfo.project.name === "mobile", "the action is the same at both widths");

    const seen: { id: string; url: string }[] = [];
    page.on("request", (request) => {
      const id = request.headers()["next-action"];
      if (request.method() === "POST" && id) seen.push({ id, url: request.url() });
    });
    const dialog = await openCredentialDialog(page);
    await dialog.getByRole("button", { name: webhooks.issue, exact: true }).click();
    await dialog.getByRole("button", { name: webhooks.tokenAcknowledge, exact: true }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);

    const forged = `${CREDENTIAL} forjada`;
    const answer = await page.request.post(seen[0].url, {
      headers: {
        "next-action": seen[0].id,
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
      },
      data: JSON.stringify([
        {
          name: forged,
          defaultAccountId: scope.accountId,
          defaultCategoryId: ids.fundCategory,
          rateLimitPerMin: 60,
        },
      ]),
    });
    expect(actionResult(await answer.text())).not.toContain('"token"');
    const stored = await fixtureSql`select id from webhook_credentials where name = ${forged}`;
    expect(stored).toHaveLength(0);
  });
});

test.describe("a delivery whose category is of another scope than its account", () => {
  test.beforeEach(async () => {
    await clearLedger();
    await fixtureSql`delete from transactions where description like ${`%${stamp}`}`;
  });

  test("names the account and not the fund's category", async ({ page }) => {
    // Kills: the category name shown regardless of the account's scope.
    await seedQueue([crossed]);
    await page.goto("/es/inbox");

    await expect(band(page).getByText(MISMATCH, { exact: true }).first()).toBeVisible();
    await expect(band(page).getByText(scope.accountName, { exact: true })).toHaveCount(1);
    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(0);
    await expect(band(page).getByText(NAME, { exact: true })).toHaveCount(0);
  });

  test("offers «Completar y anotar» and records nothing on its own", async ({ page }) => {
    // Kills: completeInput kept, so one tap writes the fund's category.
    await seedQueue([crossed]);
    await page.goto("/es/inbox");

    if (laptop(page)) {
      const table = page.getByRole("table", { name: messages.ingest.title });
      await table.getByRole("button", { name: messages.common.actionsFor.replace("{name}", MISMATCH), exact: true }).click();
      await page.getByRole("menuitem", { name: messages.ingest.accept, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: messages.ingest.accept, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: messages.ingest.review, exact: true })).toHaveCount(1);
      await page.getByRole("button", { name: messages.ingest.review, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }

    const written = await fixtureSql`select id from transactions where description = ${MISMATCH}`;
    expect(written).toHaveLength(0);
  });

  test("opens the review with the category blank and refuses to submit without one", async ({ page }) => {
    // Kills: the fund's category kept in the review's splits.
    await seedQueue([crossed]);
    await page.goto("/es/inbox");
    if (laptop(page)) {
      await page
        .getByRole("button", { name: messages.common.actionsFor.replace("{name}", MISMATCH), exact: true })
        .click();
      await page.getByRole("menuitem", { name: messages.ingest.openForm, exact: true }).click();
    } else {
      await page.getByRole("button", { name: messages.ingest.review, exact: true }).click();
    }

    const dialog = page.getByRole("dialog");
    // No category is pressed: the fund's one was dropped with the scope.
    await expect(dialog.getByRole("button", { name: NAME, exact: true, pressed: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: messages.ingest.accept, exact: true }).click();
    await expect(dialog.getByText(messages.transactions.errors.splitCategoryInvalid)).toBeVisible();
    const written = await fixtureSql`select id from transactions where description = ${MISMATCH}`;
    expect(written).toHaveLength(0);
  });

  test("records a movement with a personal split once a personal category is picked", async ({ page }) => {
    // Kills: the review that cannot be finished, or that stores the fund's category.
    const [deliveryId] = await seedQueue([crossed]);
    await page.goto("/es/inbox");
    if (laptop(page)) {
      await page
        .getByRole("button", { name: messages.common.actionsFor.replace("{name}", MISMATCH), exact: true })
        .click();
      await page.getByRole("menuitem", { name: messages.ingest.openForm, exact: true }).click();
    } else {
      await page.getByRole("button", { name: messages.ingest.review, exact: true }).click();
    }

    const dialog = page.getByRole("dialog");
    const tile = dialog.getByRole("button", { name: NAME, exact: true });
    const more = dialog.getByRole("button", { name: messages.transactions.categoryMore, exact: true });
    await expect(tile.or(more).first()).toBeVisible();
    if (!(await tile.isVisible())) await more.click();
    await tile.click();
    await dialog.getByRole("button", { name: messages.ingest.accept, exact: true }).click();
    await expect(page.getByText(messages.ingest.acceptedToast)).toBeVisible();

    const splits = await fixtureSql<{ category_id: string }[]>`
      select s.category_id from transactions t
      join transaction_splits s on s.transaction_id = t.id
      where t.description = ${MISMATCH}`;
    expect(splits.map((s) => s.category_id)).toEqual([ids.personalCategory]);
    const [delivery] = await fixtureSql<{ status: string }[]>`
      select status from ingest_deliveries where id = ${deliveryId}`;
    expect(delivery.status).toBe("accepted");
  });

  test("a forged accept of the fund's category on the personal account is refused and records nothing", async ({
    page,
  }, testInfo) => {
    // Kills: a server that trusts the card to have hidden the category.
    test.skip(testInfo.project.name === "mobile", "the action is the same at both widths");
    const [, crossedId] = await seedQueue([matching, crossed]);
    const seen: { id: string; url: string }[] = [];
    page.on("request", (request) => {
      const id = request.headers()["next-action"];
      if (request.method() === "POST" && id) seen.push({ id, url: request.url() });
    });
    await page.goto("/es/inbox");
    await page
      .getByRole("button", { name: messages.common.actionsFor.replace("{name}", MATCH), exact: true })
      .click();
    await page.getByRole("menuitem", { name: messages.ingest.accept, exact: true }).click();
    await expect(page.getByText(messages.ingest.acceptedToast)).toBeVisible();
    expect(seen.length).toBeGreaterThan(0);

    const answer = await page.request.post(seen[0].url, {
      headers: {
        "next-action": seen[0].id,
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
      },
      data: JSON.stringify([
        {
          deliveryId: crossedId,
          fromAccountId: scope.accountId,
          toAccountId: null,
          amount: "45000",
          occurredAt: "2026-10-17",
          description: MISMATCH,
          splits: [{ categoryId: ids.fundCategory, amount: "45000" }],
          labelIds: [],
        },
      ]),
    });
    expect(actionResult(await answer.text())).not.toContain('"transactionId"');

    const written = await fixtureSql`select id from transactions where description = ${MISMATCH}`;
    expect(written).toHaveLength(0);
    const [delivery] = await fixtureSql<{ status: string }[]>`
      select status from ingest_deliveries where id = ${crossedId}`;
    expect(delivery.status).toBe("pending");
  });

  test("a delivery with a fund account and a fund category keeps its one tap", async ({ page }) => {
    // Kills: every proposed category dropped.
    await seedQueue([matching]);
    await page.goto("/es/inbox");

    await expect(band(page).getByText(MARKED, { exact: true })).toHaveCount(1);
    if (laptop(page)) {
      await page
        .getByRole("button", { name: messages.common.actionsFor.replace("{name}", MATCH), exact: true })
        .click();
      await page.getByRole("menuitem", { name: messages.ingest.accept, exact: true }).click();
    } else {
      await page.getByRole("button", { name: messages.ingest.accept, exact: true }).click();
    }
    await expect(page.getByText(messages.ingest.acceptedToast)).toBeVisible();

    const splits = await fixtureSql<{ category_id: string }[]>`
      select s.category_id from transactions t
      join transaction_splits s on s.transaction_id = t.id
      where t.description = ${MATCH}`;
    expect(splits.map((s) => s.category_id)).toEqual([ids.fundCategory]);
  });
});
