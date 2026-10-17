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
      // Kills p09 at both widths: the categories page granting the fund's controls to everyone (`canManageGroup` forced true),
      // and the phone's card drawing its menu whatever the role (RF-57).
      await page.goto("/es/settings/categories");

      await expect(band(page).getByText(categoryName, { exact: true })).toHaveCount(1);
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
    await expect(menuOf(page, categoryName)).toHaveCount(1);
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

    test("sees no menu on the fund's child row", async ({ page }) => {
      // Kills: the card's menu gated on the role and the child's left drawn.
      await page.goto("/es/settings/categories");

      await expect(band(page).getByText(childName, { exact: true })).toHaveCount(1);
      await expect(menuOf(page, childName)).toHaveCount(0);
    });

    test("is offered no «Añadir categoría», on a full list or an empty one", async ({ page }) => {
      // Kills: `addButton` rendered whatever the role, in the header or in the empty state's action.
      await page.goto("/es/settings/categories");
      await expect(band(page).getByText(parentName, { exact: true })).toHaveCount(1);
      await expect(addButtons(page)).toHaveCount(0);

      await page.goto("/es/settings/categories?kind=income");
      await expect(page.getByRole("heading", { name: messages.categories.title })).toBeVisible();
      await expect(addButtons(page)).toHaveCount(0);
    });

    test("on the phone reads the fund's name, then the leader-only line, above the cards", async ({ page }) => {
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

  test.describe("the leader", () => {
    test("keeps the menu on the fund's card and its child", async ({ page }) => {
      // Kills: the menus gated on `groupName === null`, taking the leader's controls in their own fund.
      await page.goto("/es/settings/categories");

      await expect(menuOf(page, parentName)).toHaveCount(1);
      await expect(menuOf(page, childName)).toHaveCount(1);
    });

    test("is offered «Añadir categoría» once", async ({ page }) => {
      // Kills: the add button gated on `groupName === null` or drawn twice on the phone.
      await page.goto("/es/settings/categories");

      await expect(band(page).getByText(parentName, { exact: true })).toHaveCount(1);
      await expect(addButtons(page)).toHaveCount(1);
    });

    test("reads the fund's rows by their bare names", async ({ page }) => {
      // Kills: the cards or the table built from the scoped names (`{name} · fondo`); the heading names the scope.
      await page.goto("/es/settings/categories");

      const shown = band(page);
      await expect(shown.getByText(parentName, { exact: true })).toHaveCount(1);
      await expect(shown.getByText(childName, { exact: true })).toHaveCount(1);
      const marked = (name: string) => messages.categories.scopedName.replace("{name}", name);
      await expect(shown.getByText(marked(parentName))).toHaveCount(0);
      await expect(shown.getByText(marked(childName))).toHaveCount(0);
    });

    test("on the phone reads the fund's name above the cards and no leader-only line", async ({ page }) => {
      // Kills: the phone drawing no fund heading, or the leader-only line shown to everyone in a fund.
      test.skip(laptop(page), "the laptop's sections already name the fund");
      await page.goto("/es/settings/categories");

      const shown = band(page);
      await expectAbove(
        shown.getByText(GROUP_NAME, { exact: true }),
        shown.getByText(parentName, { exact: true }),
      );
      await expect(shown.getByText(messages.categories.leaderOnly, { exact: true })).toHaveCount(0);
    });

    test("on the phone an empty kind shows its empty state under the fund's name", async ({ page }) => {
      // Kills: the fund heading drawn only when the fund's list is non-empty.
      test.skip(laptop(page), "the laptop's sections already name the fund");
      await page.goto("/es/settings/categories?kind=income");

      const shown = band(page);
      await expectAbove(
        shown.getByText(GROUP_NAME, { exact: true }),
        shown.getByText(messages.categories.emptyTitle, { exact: true }),
      );
    });
  });
});

test.describe("a caller with no fund on the categories phone (C3i)", () => {
  test.beforeEach(async () => {
    await clearGroup();
  });

  test("keeps the menu on every personal category and the add button", async ({ page }) => {
    // Kills: the menus or the add button gated on `canManageGroup` alone, which is false for a caller with no fund.
    await page.goto("/es/settings/categories");

    await expect(menuOf(page, scope.categoryName)).toHaveCount(1);
    await expect(addButtons(page)).toHaveCount(1);
  });

  test("on the phone draws no fund heading and no leader-only line", async ({ page }) => {
    // Kills: the fund heading drawn with `groupName ?? ""` (an empty heading and its member line for a caller with no fund).
    test.skip(laptop(page), "the laptop's sections are guarded above");
    await page.goto("/es/settings/categories");

    const shown = band(page);
    await expect(shown.getByText(scope.categoryName, { exact: true })).toHaveCount(1);
    await expect(shown.getByText(GROUP_NAME, { exact: true })).toHaveCount(0);
    await expect(shown.getByText(messages.categories.leaderOnly, { exact: true })).toHaveCount(0);
  });
});
