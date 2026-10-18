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

import { CATEGORY_COLORS } from "@/lib/fund/category-color";
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

    test("is offered «Añadir categoría» for their own set, on either tab", async ({ page }) => {
      // Kills: `addButton` withheld from a plain member, in the header or in the empty state (RF-57, RF-63, RF-140).
      await page.goto("/es/settings/categories");
      await expect(band(page).getByText(parentName, { exact: true })).toHaveCount(1);
      await expect(addButtons(page).first()).toBeVisible();

      await page.goto("/es/settings/categories?kind=income");
      await expect(page.getByRole("heading", { name: messages.categories.title })).toBeVisible();
      await expect(addButtons(page).first()).toBeVisible();
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

// ---------------------------------------------------------------------------
// «Mis categorías» and «Dónde va» (decidido-17, M8; boards C3i and C3j).
// ---------------------------------------------------------------------------

const categories = messages.categories;
const common = messages.common;
const mobile = (page: Page): boolean => !laptop(page);

// Names carry the run's stamp and a tag, so a name on screen is this test's row.
const tagged = (tag: string): string => `${tag} ${stamp}`;

// A fixture row written as the plain member (the leader's `asHarnessUser` speaks for the first identity).
async function asMember(fn: Parameters<typeof asHarnessUser>[0]): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: scope.memberUserId,
      role: "authenticated",
      aud: "authenticated",
    })}, true)`;
    await fn(tx);
  });
}

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

function parentSelect(page: Page): Locator {
  return dialogOf(page).getByLabel(categories.parentLabel, { exact: true });
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

async function openRowItem(page: Page, rowName: string, item: string): Promise<void> {
  await menuOf(page, rowName).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

// The options a Select offers, in the order drawn.
async function optionTexts(page: Page): Promise<string[]> {
  const texts = await page.getByRole("option").allTextContents();
  return texts.map((text) => text.trim());
}

async function rowOf(name: string) {
  const [row] = await fixtureSql<
    { id: string; owner_user_id: string | null; group_id: string | null; parent_id: string | null; color: string }[]
  >`select id, owner_user_id, group_id, parent_id, color from categories where name = ${name}`;
  return row;
}

// Seeds a fund category (leader's claims) and returns its id.
async function seedFundCategory(
  groupId: string,
  name: string,
  opts: { parentId?: string; color?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, group_id, parent_id, name, kind, color)
      values (${id}, ${groupId}, ${opts.parentId ?? null}, ${name}, 'expense', ${opts.color ?? "#8C4A4A"})`;
  });
  return id;
}

async function seedPersonalCategory(
  owner: "leader" | "member",
  name: string,
  opts: { parentId?: string; color?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const run = owner === "leader" ? asHarnessUser : asMember;
  const userId = owner === "leader" ? scope.userId : scope.memberUserId;
  await run(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, parent_id, name, kind, color)
      values (${id}, ${userId}, ${opts.parentId ?? null}, ${name}, 'expense', ${opts.color ?? "#4C8C4A"})`;
  });
  return id;
}

// Holds every server action POST until `release()`, counting how many were sent and keeping their bodies.
function holdActions(page: Page) {
  const sent: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const ready = page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      sent.push(request.postData() ?? "");
      await gate;
    }
    await route.continue();
  });
  return { sent, release: open, ready };
}

function watchActions(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) {
      sent.push(request.postData() ?? "");
    }
  });
  return sent;
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

    test("with no category of their own reads «Mis categorías», its empty state and the add action, above the fund", async ({
      page,
    }) => {
      // Kills: hiding the personal section on the phone when it is empty (the member lands on the fund's list alone).
      test.skip(laptop(page), "the phone's cards are under test");
      const fundParent = tagged("Mercado vacio");
      await seedFundCategory(groupId, fundParent);

      await page.goto("/es/settings/categories");

      const shown = band(page);
      const heading = shown.getByRole("heading", { name: categories.personalSection, level: 2 });
      const emptyTitle = shown.getByText(categories.personalEmptyTitle, { exact: true });
      await expect(shown.getByText(categories.personalEmptyDescription, { exact: true })).toBeVisible();
      await expect(
        shown.getByRole("button", { name: categories.add, exact: true }),
      ).toBeVisible();
      await expectAbove(heading, emptyTitle);
      await expectAbove(emptyTitle, shown.getByRole("heading", { name: GROUP_NAME, level: 2 }));
      await expectAbove(shown.getByText(categories.leaderOnly, { exact: true }), shown.getByText(fundParent, { exact: true }));
      await expect(menuOf(page, fundParent)).toHaveCount(0);
      expect(await addButtons(page).count()).toBe(2);
    });

    test("sees their own card under «Mis categorías» with a menu, and the fund's below with none", async ({
      page,
    }) => {
      // Kills: drawing `categories` (the effective scope) alone, which leaves the member's own set off the phone.
      const own = tagged("Gimnasio");
      const fundParent = tagged("Mercado fondo");
      await seedPersonalCategory("member", own);
      await seedFundCategory(groupId, fundParent);

      await page.goto("/es/settings/categories");

      const shown = band(page);
      await expect(shown.getByText(own, { exact: true })).toHaveCount(1);
      await expect(shown.getByText(fundParent, { exact: true })).toHaveCount(1);
      await expect(menuOf(page, own)).toHaveCount(1);
      await expect(menuOf(page, fundParent)).toHaveCount(0);
      await expect(shown.getByRole("heading", { name: categories.personalSection })).toBeVisible();
      if (mobile(page)) {
        await expectAbove(
          shown.getByRole("heading", { name: categories.personalSection }),
          shown.getByText(own, { exact: true }),
        );
        await expectAbove(shown.getByText(own, { exact: true }), shown.getByRole("heading", { name: GROUP_NAME }));
        await expectAbove(shown.getByRole("heading", { name: GROUP_NAME }), shown.getByText(fundParent, { exact: true }));
      }
    });

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

    test("never gets the fund's place: no «Del fondo» option, and the fund's rows have no menu", async ({ page }) => {
      // Kills: offering both placements to everyone (the select and «Del fondo» appear for a member).
      const fundParent = tagged("Fondo ajeno");
      const fundChild = tagged("Fondo ajeno hijo");
      const parentId = await seedFundCategory(groupId, fundParent);
      await seedFundCategory(groupId, fundChild, { parentId });

      await page.goto("/es/settings/categories");
      await expect(menuOf(page, fundParent)).toHaveCount(0);
      await expect(menuOf(page, fundChild)).toHaveCount(0);

      await openAdd(page);
      await expect(page.getByRole("option", { name: categories.placementGroup, exact: true })).toHaveCount(0);
      await expect(dialogOf(page).getByText(categories.placementGroup, { exact: true })).toHaveCount(0);
      await expect(dialogOf(page).getByRole("combobox")).toHaveCount(1);
    });

    test("is offered only their own parents in the dialog", async ({ page }) => {
      // Kills: handing the member the fund's parent list (a fund parent is offered, and a write under it is refused).
      const ownParent = tagged("Padre propio");
      const fundParent = tagged("Padre del fondo");
      await seedPersonalCategory("member", ownParent);
      await seedFundCategory(groupId, fundParent);

      await page.goto("/es/settings/categories");
      await openAdd(page);
      await parentSelect(page).click();

      const options = page.getByRole("option");
      await expect(options.filter({ hasText: ownParent })).toHaveCount(1);
      await expect(options.filter({ hasText: fundParent })).toHaveCount(0);
    });

    test("edits and deletes their own category", async ({ page }) => {
      // Kills: a member's own rows drawn without the Edit and Delete items, or the write refused.
      const own = tagged("Para editar");
      const renamed = tagged("Ya editada");
      await seedPersonalCategory("member", own);

      await page.goto("/es/settings/categories");
      await openRowItem(page, own, common.edit);
      await expect(dialogOf(page).getByText(categories.editTitle, { exact: true })).toBeVisible();
      await nameField(page).fill(renamed);
      await saveButton(page).click();
      await expect(page.getByText(categories.updated, { exact: true }).first()).toBeVisible();
      await expect(band(page).getByText(renamed, { exact: true })).toHaveCount(1);
      expect((await rowOf(renamed)).owner_user_id).toBe(scope.memberUserId);

      await openRowItem(page, renamed, common.delete);
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: common.delete, exact: true })
        .click();
      await expect(band(page).getByText(renamed, { exact: true })).toHaveCount(0);
      expect(await rowOf(renamed)).toBeUndefined();
    });

    test("is offered «Añadir subcategoría» on their own parent, never on a subcategory", async ({ page }) => {
      // Kills: `canAddSub` true on children, or withheld from a member's own parent.
      const parent = tagged("Padre sub");
      const child = tagged("Hijo sub");
      const parentId = await seedPersonalCategory("member", parent);
      await seedPersonalCategory("member", child, { parentId, color: "#8C4A4A" });

      await page.goto("/es/settings/categories");

      await menuOf(page, parent).click();
      await expect(page.getByRole("menuitem", { name: categories.addSub, exact: true })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await menuOf(page, child).click();
      await expect(page.getByRole("menuitem", { name: common.edit, exact: true })).toHaveCount(1);
      await expect(page.getByRole("menuitem", { name: categories.addSub, exact: true })).toHaveCount(0);
    });
  });

  test.describe("the leader", () => {
    test("is offered «Dónde va» with «Del fondo» first and selected, then «Mías»", async ({ page }) => {
      // Kills: offering the leader one placement, or the personal one first.
      await page.goto("/es/settings/categories");
      await openAdd(page);

      await expect(placementSelect(page)).toBeVisible();
      await expect(placementSelect(page)).toHaveText(categories.placementGroup);
      await placementSelect(page).click();
      expect(await optionTexts(page)).toEqual([categories.placementGroup, categories.placementPersonal]);
    });

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

    test("choosing «Mías» lands the category in their own set", async ({ page }) => {
      // Kills: ignoring the chosen placement (always the fund's, or always the caller's own).
      const name = tagged("Mia nueva");
      await page.goto("/es/settings/categories");
      await openAdd(page);
      await placementSelect(page).click();
      await page.getByRole("option", { name: categories.placementPersonal, exact: true }).click();
      await nameField(page).fill(name);
      await saveButton(page).click();

      await expect(page.getByText(categories.created, { exact: true }).first()).toBeVisible();
      await expect(dialogOf(page)).toBeHidden();
      const row = await rowOf(name);
      expect(row.owner_user_id).toBe(scope.userId);
      expect(row.group_id).toBeNull();
    });

    test("switching the place re-reads the parents, the default colour, and drops a parent of the other place", async ({
      page,
    }) => {
      // Kills: keeping the fund's parents, the fund's default colour, or the picked fund parent after the switch.
      const fundParent = tagged("Padre fondo");
      const ownParent = tagged("Padre mio");
      await seedFundCategory(groupId, fundParent, { color: CATEGORY_COLORS[0] });
      await seedPersonalCategory("leader", ownParent, { color: CATEGORY_COLORS[1] });
      // The fund has used the palette's first colour, the leader's own set its second.
      const colorOption = (index: number) => categories.colorOption.replace("{number}", String(index + 1));

      await page.goto("/es/settings/categories");
      await openAdd(page);

      await expect(dialogOf(page).getByRole("radio", { name: colorOption(1), exact: true })).toBeChecked();
      await parentSelect(page).click();
      let options = page.getByRole("option");
      await expect(options.filter({ hasText: fundParent })).toHaveCount(1);
      await expect(options.filter({ hasText: ownParent })).toHaveCount(0);
      await options.filter({ hasText: fundParent }).click();
      await expect(parentSelect(page)).toHaveText(fundParent);

      await placementSelect(page).click();
      await page.getByRole("option", { name: categories.placementPersonal, exact: true }).click();

      await expect(parentSelect(page)).toHaveText(categories.parentNone);
      await expect(dialogOf(page).getByRole("radio", { name: colorOption(0), exact: true })).toBeChecked();
      await parentSelect(page).click();
      options = page.getByRole("option");
      await expect(options.filter({ hasText: ownParent })).toHaveCount(1);
      await expect(options.filter({ hasText: fundParent })).toHaveCount(0);
    });

    test("sees «Mis categorías» with a menu on every own row and the fund's rows with menus, no leader-only line", async ({
      page,
    }) => {
      // Kills: the leader's own section drawn without menus, or the member's line shown to the leader.
      const fundParent = tagged("Mercado lider");
      await seedFundCategory(groupId, fundParent);

      await page.goto("/es/settings/categories");

      await expect(menuOf(page, scope.categoryName)).toHaveCount(1);
      await expect(menuOf(page, fundParent)).toHaveCount(1);
      await expect(band(page).getByText(categories.leaderOnly, { exact: true })).toHaveCount(0);
      if (mobile(page)) {
        await expectAbove(
          band(page).getByRole("heading", { name: categories.personalSection, level: 2 }),
          band(page).getByText(scope.categoryName, { exact: true }),
        );
        await expectAbove(
          band(page).getByText(scope.categoryName, { exact: true }),
          band(page).getByRole("heading", { name: GROUP_NAME, level: 2 }),
        );
      }
    });

    test("«Añadir subcategoría» sits on every parent and on no subcategory, in both sets", async ({ page }) => {
      // Kills: `canAddSub: true` on children; negating `row.canAddSub`.
      const fundParent = tagged("Padre F");
      const fundChild = tagged("Hijo F");
      const ownParent = tagged("Padre P");
      const ownChild = tagged("Hijo P");
      const fundParentId = await seedFundCategory(groupId, fundParent);
      await seedFundCategory(groupId, fundChild, { parentId: fundParentId, color: "#4C8C4A" });
      const ownParentId = await seedPersonalCategory("leader", ownParent);
      await seedPersonalCategory("leader", ownChild, { parentId: ownParentId, color: "#8C4A4A" });

      await page.goto("/es/settings/categories");

      const addSub = page.getByRole("menuitem", { name: categories.addSub, exact: true });
      for (const parent of [fundParent, ownParent]) {
        await menuOf(page, parent).click();
        await expect(addSub).toHaveCount(1);
        await page.keyboard.press("Escape");
      }
      for (const child of [fundChild, ownChild]) {
        await menuOf(page, child).click();
        await expect(page.getByRole("menuitem", { name: common.edit, exact: true })).toHaveCount(1);
        await expect(addSub).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
    });

    for (const place of ["personal", "group"] as const) {
      test(`«Añadir subcategoría» on a ${place === "group" ? "fund" : "personal"} parent writes a child in that place`, async ({
        page,
      }) => {
        // Kills: `||` for `&&` in the sub-add scope; swapping the effective scope (the child lands in the other place).
        const parent = tagged(`Padre destino ${place}`);
        const child = tagged(`Hijo destino ${place}`);
        const parentId =
          place === "group"
            ? await seedFundCategory(groupId, parent)
            : await seedPersonalCategory("leader", parent);

        await page.goto("/es/settings/categories");
        await openRowItem(page, parent, categories.addSub);
        await expect(dialogOf(page)).toBeVisible();
        await expect(placementSelect(page)).toHaveCount(0);
        await expect(parentSelect(page)).toHaveText(parent);
        await nameField(page).fill(child);
        await saveButton(page).click();

        await expect(page.getByText(categories.created, { exact: true }).first()).toBeVisible();
        const row = await rowOf(child);
        expect(row.parent_id).toBe(parentId);
        if (place === "group") {
          expect(row.group_id).toBe(groupId);
          expect(row.owner_user_id).toBeNull();
        } else {
          expect(row.owner_user_id).toBe(scope.userId);
          expect(row.group_id).toBeNull();
        }
      });
    }

    test("while the create is held, every field and both buttons are disabled and «Guardar» spins", async ({
      page,
    }) => {
      // Kills: leaving the placement select (or any field) enabled while pending; dropping the spinner.
      const name = tagged("Pendiente");
      const held = holdActions(page);
      await held.ready;
      await page.goto("/es/settings/categories");
      await openAdd(page);
      await nameField(page).fill(name);
      await saveButton(page).click();

      await expect(saveButton(page)).toBeDisabled();
      await expect(saveButton(page).locator(".rt-Spinner")).toBeVisible();
      await expect(nameField(page)).toBeDisabled();
      await expect(placementSelect(page)).toBeDisabled();
      await expect(parentSelect(page)).toBeDisabled();
      await expect(
        dialogOf(page).getByRole("button", { name: common.cancel, exact: true }),
      ).toBeDisabled();
      expect(held.sent).toHaveLength(1);

      held.release();
      await expect(dialogOf(page)).toBeHidden();
      expect((await rowOf(name)).group_id).toBe(groupId);
    });

    test("«Cancelar» sends nothing and adds no row", async ({ page }) => {
      // Kills: submitting on close.
      const name = tagged("Cancelada");
      const sent = watchActions(page);
      await page.goto("/es/settings/categories");
      await openAdd(page);
      await nameField(page).fill(name);
      await dialogOf(page).getByRole("button", { name: common.cancel, exact: true }).click();

      await expect(dialogOf(page)).toBeHidden();
      await expect(band(page).getByText(name, { exact: true })).toHaveCount(0);
      expect(sent).toHaveLength(0);
      expect(await rowOf(name)).toBeUndefined();
    });

    test("a refusal from the server shows as a toast and the dialog stays open", async ({ page }) => {
      // Kills: closing the dialog on error.
      const target = tagged("Hijo refusado");
      const wouldBeParent = tagged("Padre que se anida");
      const newRoot = tagged("Raiz que lo anida");
      const wouldBeParentId = await seedFundCategory(groupId, wouldBeParent);
      const rootId = await seedFundCategory(groupId, newRoot);

      await page.goto("/es/settings/categories");
      await openAdd(page);
      await nameField(page).fill(target);
      await parentSelect(page).click();
      await page.getByRole("option").filter({ hasText: wouldBeParent }).click();
      // While the form is open another session nests the picked parent, so the write would be a third level.
      await asHarnessUser(async (tx) => {
        await tx`update categories set parent_id = ${rootId} where id = ${wouldBeParentId}`;
      });
      await saveButton(page).click();

      await expect(page.getByText(messages.errors.categoryNesting, { exact: true }).first()).toBeVisible();
      await expect(dialogOf(page)).toBeVisible();
      expect(await rowOf(target)).toBeUndefined();
    });

    test("editing a personal category shows the locked place, sends no placement and keeps it personal", async ({
      page,
    }) => {
      // Kills: sending `placement` on edit; a select instead of the locked line.
      const own = tagged("Editar mia");
      const renamed = tagged("Editada mia");
      await seedPersonalCategory("leader", own);
      const sent = watchActions(page);

      await page.goto("/es/settings/categories");
      await openRowItem(page, own, common.edit);

      await expect(placementSelect(page)).toHaveCount(0);
      await expect(dialogOf(page).getByText(categories.placementPersonal, { exact: true })).toBeVisible();
      await expect(dialogOf(page).getByText(categories.placementLocked, { exact: true })).toBeVisible();
      await nameField(page).fill(renamed);
      await saveButton(page).click();

      await expect(page.getByText(categories.updated, { exact: true }).first()).toBeVisible();
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain("placement");
      const row = await rowOf(renamed);
      expect(row.owner_user_id).toBe(scope.userId);
      expect(row.group_id).toBeNull();
    });

    test("editing a fund category shows «Del fondo» locked and keeps it in the fund", async ({ page }) => {
      // Kills: the locked line naming the wrong place, or an edit moving the row.
      const fundRow = tagged("Editar fondo");
      const renamed = tagged("Editada fondo");
      await seedFundCategory(groupId, fundRow);
      const sent = watchActions(page);

      await page.goto("/es/settings/categories");
      await openRowItem(page, fundRow, common.edit);

      await expect(placementSelect(page)).toHaveCount(0);
      await expect(dialogOf(page).getByText(categories.placementGroup, { exact: true })).toBeVisible();
      await expect(dialogOf(page).getByText(categories.placementLocked, { exact: true })).toBeVisible();
      await nameField(page).fill(renamed);
      await saveButton(page).click();

      await expect(page.getByText(categories.updated, { exact: true }).first()).toBeVisible();
      expect(sent[0]).not.toContain("placement");
      expect((await rowOf(renamed)).group_id).toBe(groupId);
    });
  });
});

test.describe("a caller with no fund, «Mis categorías» and «Dónde va» (decidido-17)", () => {
  test.beforeEach(async () => {
    await clearGroup();
  });

  test.afterEach(async () => {
    await dropRowsOfRun();
  });

  test("sees one list: no «Mis categorías» heading, no fund heading, no «Dónde va»", async ({ page }) => {
    // Kills: showing the select with one option; a personal heading over the only list.
    const name = tagged("Sin fondo");
    await page.goto("/es/settings/categories");

    if (mobile(page)) {
      await expect(band(page).getByText(categories.personalSection, { exact: true })).toHaveCount(0);
    }
    await expect(band(page).getByText(GROUP_NAME, { exact: true })).toHaveCount(0);

    await openAdd(page);
    await expect(placementSelect(page)).toHaveCount(0);
    await expect(dialogOf(page).getByText(categories.placementLabel, { exact: true })).toHaveCount(0);
    await nameField(page).fill(name);
    await saveButton(page).click();

    await expect(page.getByText(categories.created, { exact: true }).first()).toBeVisible();
    const row = await rowOf(name);
    expect(row.owner_user_id).toBe(scope.userId);
    expect(row.group_id).toBeNull();
  });
});
