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
