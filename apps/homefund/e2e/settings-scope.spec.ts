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
  MEMBER_STORAGE_STATE,
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
});

// Every «Añadir categoría» a person can see: the header's and an empty state's (RF-57, Q1 a of 2026-10-17).
function addButtons(page: Page): Locator {
  return page
    .getByRole("button", { name: messages.categories.add, exact: true })
    .filter({ visible: true });
}

// Asserts `upper` is drawn above `lower` on the page, both visible.
async function expectAbove(upper: Locator, lower: Locator): Promise<void> {
  await expect(upper).toBeVisible();
  await expect(lower).toBeVisible();
  const [top, bottom] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
  expect(top && bottom && top.y < bottom.y).toBe(true);
}

// Board C3i: the categories phone in a fund names the fund once and offers a
// role only the controls it may use; the laptop already did (RF-57, RF-63, RF-140).
test.describe("the fund's categories by role (C3i)", () => {
  const parentId = randomUUID();
  const childId = randomUUID();
  const parentName = `Mercado del fondo ${stamp}`;
  const childName = `Verduras del fondo ${stamp}`;

  test.beforeEach(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, group_id, name, kind, color)
        values (${parentId}, ${groupId}, ${parentName}, 'expense', '#8C4A4A')`;
      await tx`
        insert into categories (id, group_id, parent_id, name, kind)
        values (${childId}, ${groupId}, ${parentId}, ${childName}, 'expense')`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from categories where id in (${childId}, ${parentId})`;
  });

  test.describe("a plain member", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("on the phone reads the fund's name, then the leader-only line, above the cards @mobile", async ({ page }) => {
      // Kills: the phone drawing no fund heading, or no leader-only line for a member.
      test.skip(laptop(page), "the laptop's sections already name the fund");
      await page.goto("/es/settings/categories");

      const shown = band(page);
      const heading = shown.getByText(GROUP_NAME, { exact: true });
      const note = shown.getByText(messages.categories.leaderOnly, { exact: true });
      await expect(heading).toHaveCount(1);
      await expect(note).toHaveCount(1);
      await expectAbove(heading, note);
      await expectAbove(note, shown.getByText(parentName, { exact: true }));
    });
  });
});

// ---------------------------------------------------------------------------
// «Mis categorías» and «Dónde va» (decidido-17, M8; boards C3i and C3j).
// ---------------------------------------------------------------------------

const categories = messages.categories;
const common = messages.common;
const mobile = (page: Page): boolean => !laptop(page);

// Names carry the run's stamp and a tag, so a name on screen is this test's row.
const tagged = (tag: string): string => `${tag} ${stamp}`;

async function dropRowsOfRun(): Promise<void> {
  const like = `% ${stamp}`;
  await fixtureSql`delete from categories where parent_id is not null and name like ${like}`;
  await fixtureSql`delete from categories where name like ${like}`;
}

function dialogOf(page: Page): Locator {
  return page.getByRole("dialog");
}

function placementSelect(page: Page): Locator {
  return dialogOf(page).getByRole("combobox", { name: categories.placementLabel, exact: true });
}

function nameField(page: Page): Locator {
  return dialogOf(page).getByRole("textbox", { name: categories.nameLabel });
}

function saveButton(page: Page): Locator {
  return dialogOf(page).getByRole("button", { name: common.save, exact: true });
}

async function openAdd(page: Page): Promise<void> {
  await addButtons(page).first().click();
  await expect(dialogOf(page)).toBeVisible();
}

async function rowOf(name: string) {
  const [row] = await fixtureSql<
    { id: string; owner_user_id: string | null; group_id: string | null; parent_id: string | null; color: string }[]
  >`select id, owner_user_id, group_id, parent_id, color from categories where name = ${name}`;
  return row;
}

test.describe("«Mis categorías» and «Dónde va» (decidido-17)", () => {
  let groupId: string;

  test.beforeEach(async () => {
    ({ groupId } = await seedGroup());
  });

  test.afterEach(async () => {
    await dropRowsOfRun();
  });

  test.describe("a plain member", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("adds a category: no «Dónde va», a toast, the row under «Mis categorías», and it is the member's own", async ({
      page,
    }) => {
      // Kills: sending `placement: "group"` for a member (the server refuses, no row), and the dialog offering the fund.
      const name = tagged("Propia nueva");
      await page.goto("/es/settings/categories");
      await openAdd(page);

      await expect(placementSelect(page)).toHaveCount(0);
      await expect(dialogOf(page).getByText(categories.placementLabel, { exact: true })).toHaveCount(0);
      await expect(dialogOf(page).getByText(categories.placementGroup, { exact: true })).toHaveCount(0);

      await nameField(page).fill(name);
      await saveButton(page).click();

      await expect(page.getByText(categories.created, { exact: true }).first()).toBeVisible();
      await expect(dialogOf(page)).toBeHidden();
      await expect(band(page).getByText(name, { exact: true })).toHaveCount(1);
      if (mobile(page)) {
        await expectAbove(
          band(page).getByRole("heading", { name: categories.personalSection }),
          band(page).getByText(name, { exact: true }),
        );
      }
      const row = await rowOf(name);
      expect(row.owner_user_id).toBe(scope.memberUserId);
      expect(row.group_id).toBeNull();
    });
  });

  test.describe("the leader", () => {

    test("saves into the fund by default", async ({ page }) => {
      // Kills: a default of «Mías» for the leader, or a placement never sent (the row would land personal).
      const name = tagged("Del fondo nueva");
      await page.goto("/es/settings/categories");
      await openAdd(page);
      await nameField(page).fill(name);
      await saveButton(page).click();

      await expect(dialogOf(page)).toBeHidden();
      await expect(band(page).getByText(name, { exact: true })).toHaveCount(1);
      const row = await rowOf(name);
      expect(row.group_id).toBe(groupId);
      expect(row.owner_user_id).toBeNull();
    });
  });
});
