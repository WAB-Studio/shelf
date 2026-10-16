/**
 * The members, categories and labels screens read the caller's scope: a fund
 * when they belong to one, their personal set when they do not (RF-55, RF-63,
 * RF-70, RF-100). The pages are rewired onto one loader each, so these specs fix
 * what the screens must keep showing whichever way the rows are fetched: the
 * roster by tab, the personal set once, both scopes with their counts, and the
 * 404 of a caller with no fund.
 *
 * Every row is written under the harness identity and dropped by id; the group
 * goes through `clearGroup`.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  LEADER_MEMBER_NAME,
  MEMBER_STORAGE_STATE,
  PLAIN_MEMBER_NAME,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const GROUP_NAME = "Fondo de la prueba";

function atCount(message: string, count: number): string {
  const branch = /other \{([^}]*)\}/.exec(message)?.[1] ?? message;
  return branch.replace("#", String(count));
}

// The width's visible band: the laptop's table and the phone's cards both sit in the DOM.
// The laptop band draws both scopes at once (RF-63, RF-70); the phone draws the
// effective one, the fund's while the caller has one.
function laptop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 1024;
}

function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

test.afterAll(async () => {
  await clearGroup();
});

test.describe("members", () => {
  const archivedName = `Harness archivado ${stamp}`;

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into group_members (group_id, name, role, archived_at)
        values (${groupId}, ${archivedName}, 'member', now())`;
    });
  });

  test("the live tab lists the unarchived members by name and none archived", async ({ page }) => {
    // Kills: the archived predicate dropped from the roster read (the archived member shows on the live tab).
    await page.goto("/es/settings/members");

    await expect(band(page).getByText(LEADER_MEMBER_NAME, { exact: true }).first()).toBeVisible();
    await expect(band(page).getByText(PLAIN_MEMBER_NAME, { exact: true }).first()).toBeVisible();
    await expect(band(page).getByText(archivedName, { exact: true })).toHaveCount(0);
  });

  test("the archived tab lists only the archived", async ({ page }) => {
    // Kills: the archived flag ignored (the live members show beside the archived one).
    await page.goto("/es/settings/members?tab=archived");

    await expect(band(page).getByText(archivedName, { exact: true }).first()).toBeVisible();
    await expect(band(page).getByText(LEADER_MEMBER_NAME, { exact: true })).toHaveCount(0);
    await expect(band(page).getByText(PLAIN_MEMBER_NAME, { exact: true })).toHaveCount(0);
  });
});

test("a caller with no fund gets a 404 on the members route", async ({ page }) => {
  // Kills: dropping the no-group refusal (an empty roster over a 200).
  await clearGroup();

  const response = await page.goto("/es/settings/members");

  expect(response?.status()).toBe(404);
  await expect(page.getByText(messages.errors.notFoundTitle, { exact: true })).toBeVisible();
});

test.describe("categories", () => {
  const groupCategoryId = randomUUID();
  const groupCategoryName = `Categoría del fondo ${stamp}`;

  test.afterEach(async () => {
    await fixtureSql`delete from categories where id = ${groupCategoryId}`;
  });

  test("a leader in a fund sees the fund's set and their own, each under its heading", async ({ page }) => {
    // Kills: the personal set read as the fund's (one set missing, the other drawn twice).
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${groupCategoryId}, ${groupId}, ${groupCategoryName}, 'expense', '#8C4A4A')`;
    });

    await page.goto("/es/settings/categories");

    const shown = band(page);
    await expect(shown.getByText(groupCategoryName, { exact: true })).toHaveCount(1);
    if (!laptop(page)) return;
    await expect(shown.getByText(scope.categoryName, { exact: true })).toHaveCount(1);
    await expect(shown.getByText(GROUP_NAME, { exact: true }).first()).toBeVisible();
    await expect(shown.getByText(messages.categories.personalSection, { exact: true }).first()).toBeVisible();
  });

  test("a caller with no fund sees their personal set once and no fund heading", async ({ page }) => {
    // Kills: the personal set read twice for an ungrouped caller (the same name drawn in two sections).
    await clearGroup();

    await page.goto("/es/settings/categories");

    const shown = band(page);
    await expect(shown.getByText(scope.categoryName, { exact: true })).toHaveCount(1);
    await expect(shown.getByText(GROUP_NAME, { exact: true })).toHaveCount(0);
    await expect(shown.getByText(groupCategoryName, { exact: true })).toHaveCount(0);
  });

  test("an unknown kind opens the expense tab, not a missing page", async ({ page }) => {
    // Kills: the kind parameter handed to the loader unparsed (a mistyped tab breaks the page).
    await clearGroup();

    const response = await page.goto("/es/settings/categories?kind=bogus");

    expect(response?.status()).toBe(200);
    await expect(band(page).getByText(scope.categoryName, { exact: true })).toHaveCount(1);
  });
});

test.describe("labels", () => {
  const personalLabelId = randomUUID();
  const groupLabelId = randomUUID();
  const movementId = randomUUID();
  const personalName = `Etiqueta propia ${stamp}`;
  const groupName = `Etiqueta del fondo ${stamp}`;

  async function seedPersonalLabelWithOneMovement() {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into labels (id, owner_user_id, name, color)
        values (${personalLabelId}, ${scope.userId}, ${personalName}, '#4C8C4A')`;
      await tx`
        insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
        values (${movementId}, ${scope.accountId}, 1000, current_date, 'Harness etiquetado')`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movementId}, ${scope.categoryId}, 1000)`;
      await tx`insert into transaction_labels (transaction_id, label_id) values (${movementId}, ${personalLabelId})`;
    });
  }

  test.afterEach(async () => {
    await fixtureSql`delete from transactions where id = ${movementId}`;
    await fixtureSql`delete from labels where id in (${personalLabelId}, ${groupLabelId})`;
  });

  test("a leader in a fund sees both scopes, each label with its own count", async ({ page }) => {
    // Kills: one scope's labels read for both (a name missing) or the counts swapped between scopes.
    const { groupId } = await seedGroup();
    await seedPersonalLabelWithOneMovement();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into labels (id, group_id, name, color)
        values (${groupLabelId}, ${groupId}, ${groupName}, '#8C4A4A')`;
    });

    await page.goto("/es/settings/labels");

    const shown = band(page);
    await expect(shown.getByText(groupName, { exact: true })).toHaveCount(1);
    if (!laptop(page)) return;
    await expect(shown.getByText(personalName, { exact: true })).toHaveCount(1);

    const personalRow = shown.getByRole("row").filter({ hasText: personalName });
    const groupRow = shown.getByRole("row").filter({ hasText: groupName });
    await expect(
      shown
        .getByText(atCount(messages.labels.usageCount, 1), { exact: true })
        .or(personalRow.getByRole("cell").nth(2).getByText("1", { exact: true })),
    ).toBeVisible();
    await expect(
      shown
        .getByText(atCount(messages.labels.usageCount, 0), { exact: true })
        .or(groupRow.getByRole("cell").nth(2).getByText("0", { exact: true })),
    ).toBeVisible();
  });

  test("a caller with no fund sees the personal scope alone", async ({ page }) => {
    // Kills: a fund scope invented for an ungrouped caller (the fund's label or heading appears).
    await clearGroup();
    await seedPersonalLabelWithOneMovement();

    await page.goto("/es/settings/labels");

    const shown = band(page);
    await expect(shown.getByText(personalName, { exact: true })).toHaveCount(1);
    await expect(shown.getByText(GROUP_NAME, { exact: true })).toHaveCount(0);
    await expect(shown.getByText(groupName, { exact: true })).toHaveCount(0);
  });
});

// The row menu's accessible name, built from the same catalogue entry the table reads.
function menuOf(page: Page, name: string): Locator {
  return band(page).getByRole("button", {
    name: messages.common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

test.describe("an archived member", () => {
  const categoryId = randomUUID();
  const labelId = randomUUID();
  const categoryName = `Categoría del fondo archivado ${stamp}`;
  const labelName = `Etiqueta del fondo archivado ${stamp}`;

  test.use({ storageState: MEMBER_STORAGE_STATE });

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${categoryId}, ${groupId}, ${categoryName}, 'expense', '#8C4A4A')`;
      await tx`
        insert into labels (id, group_id, name, color)
        values (${labelId}, ${groupId}, ${labelName}, '#8C4A4A')`;
      await tx`
        update group_members set archived_at = now()
        where group_id = ${groupId} and name = ${PLAIN_MEMBER_NAME}`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from categories where id = ${categoryId}`;
    await fixtureSql`delete from labels where id = ${labelId}`;
  });

  test("resolves no fund on the members screen", async ({ page }) => {
    // Pins the outcome, not the layer: the fund lookup's archived predicate and the `groups` policy each refuse it, so dropping the predicate alone changes nothing.
    const response = await page.goto("/es/settings/members");

    expect(response?.status()).toBe(404);
    await expect(page.getByText(messages.errors.notFoundTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(LEADER_MEMBER_NAME, { exact: true })).toHaveCount(0);
  });

  test("sees no fund section on the categories screen", async ({ page }) => {
    // Pins the outcome as above, on the categories loader (neither the fund's heading nor its set is drawn).
    await page.goto("/es/settings/categories");

    const shown = band(page);
    await expect(page.getByRole("heading", { name: messages.categories.title })).toBeVisible();
    await expect(shown.getByText(categoryName, { exact: true })).toHaveCount(0);
    if (!laptop(page)) return;
    await expect(shown.getByText(messages.categories.personalSection, { exact: true }).first()).toBeVisible();
    await expect(shown.getByText(GROUP_NAME, { exact: true })).toHaveCount(0);
  });

  test("sees no fund section on the labels screen", async ({ page }) => {
    // Pins the outcome as above, on the labels loader (the fund's heading is not drawn over the personal set).
    await page.goto("/es/settings/labels");

    const shown = band(page);
    await expect(page.getByRole("heading", { name: messages.labels.title })).toBeVisible();
    await expect(shown.getByText(labelName, { exact: true })).toHaveCount(0);
    await expect(shown.getByText(GROUP_NAME, { exact: true })).toHaveCount(0);
  });
});

test.describe("a plain member", () => {
  const categoryId = randomUUID();
  const labelId = randomUUID();
  const categoryName = `Categoría del fondo ajena ${stamp}`;
  const labelName = `Etiqueta del fondo ajena ${stamp}`;

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${categoryId}, ${groupId}, ${categoryName}, 'expense', '#8C4A4A')`;
      await tx`
        insert into labels (id, group_id, name, color)
        values (${labelId}, ${groupId}, ${labelName}, '#8C4A4A')`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from categories where id = ${categoryId}`;
    await fixtureSql`delete from labels where id = ${labelId}`;
  });

  test.describe("reading", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("sees the fund's categories and no menu on any of them", async ({ page }) => {
      // Kills: the categories page granting the fund's controls to everyone (`canManageGroup` forced true).
      await page.goto("/es/settings/categories");

      await expect(band(page).getByText(categoryName, { exact: true })).toHaveCount(1);
      if (!laptop(page)) return;
      await expect(menuOf(page, categoryName)).toHaveCount(0);
    });

    test("sees the fund's labels and no menu on any of them", async ({ page }) => {
      // Kills: the labels loader or page granting the fund's controls to a member (`isLeader` or `canManageGroup` forced true).
      await page.goto("/es/settings/labels");

      await expect(band(page).getByText(labelName, { exact: true })).toHaveCount(1);
      await expect(menuOf(page, labelName)).toHaveCount(0);
      if (laptop(page)) return;
      await expect(band(page).getByText(messages.labels.leaderOnly, { exact: true })).toBeVisible();
    });
  });

  test("the leader has the menu where the member has none", async ({ page }) => {
    // Kills: the two member tests passing because the menu is never drawn at all.
    await page.goto("/es/settings/labels");

    await expect(band(page).getByText(labelName, { exact: true })).toHaveCount(1);
    await expect(menuOf(page, labelName)).toHaveCount(1);
    await expect(band(page).getByText(messages.labels.leaderOnly, { exact: true })).toHaveCount(0);

    await page.goto("/es/settings/categories");
    await expect(band(page).getByText(categoryName, { exact: true })).toHaveCount(1);
    if (laptop(page)) await expect(menuOf(page, categoryName)).toHaveCount(1);
  });
});

test.describe("income parents", () => {
  const incomeId = randomUUID();
  const expenseId = randomUUID();
  const incomeName = `Ingreso principal ${stamp}`;
  const expenseName = `Gasto principal ${stamp}`;

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values
          (${incomeId}, ${groupId}, ${incomeName}, 'income', '#4C8C4A'),
          (${expenseId}, ${groupId}, ${expenseName}, 'expense', '#8C4A4A')`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from categories where id in (${incomeId}, ${expenseId})`;
  });

  test("the picker of a new income category offers income parents only", async ({ page }) => {
    // Kills: the parent list read for the expense kind whichever tab is open (an expense category is offered, an income one is not).
    await page.goto("/es/settings/categories?kind=income");
    await expect(band(page).getByText(incomeName, { exact: true })).toHaveCount(1);

    await page
      .getByRole("button", { name: messages.categories.add, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole("dialog").getByLabel(messages.categories.parentLabel).click();

    const options = page.getByRole("option");
    await expect(options.filter({ hasText: incomeName })).toHaveCount(1);
    await expect(options.filter({ hasText: expenseName })).toHaveCount(0);
  });
});
