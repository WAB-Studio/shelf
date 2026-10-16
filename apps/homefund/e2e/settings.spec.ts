/**
 * One pass over the seven settings screens, none of which any check had opened.
 * The HTTP layer already proves each route answers 200; what it cannot prove is
 * that the data reached the screen — the whole next-intl catalogue ships in the
 * page payload, so a title matches even when nothing rendered. Every assertion
 * here is therefore a seeded value or an interpolated message carrying one.
 *
 * The RF-100 describes prove that requirement on screen, under both roles. The
 * database half is proved by layer 1 (assertions 184-189); nothing until now
 * rendered the roster, and the row menu is only reachable here — Radix mounts a
 * menu's items when it opens and never puts them on the wire.
 *
 * The last describe drives the group's own settings (RF-56, RF-57): its form is
 * the one place where the two columns the leader may write are written at all,
 * and every value it saves is read back from Postgres, never from the screen
 * that wrote it.
 */
import { createHash, randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { GROUP_CASH_ACCOUNT_NAME } from "@/lib/fund/seed";
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

const members = messages.members;
const common = messages.common;
const group = messages.group;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

// The `other` branch of an ICU plural with `#` filled, which is what a count
// renders as on screen once it leaves the catalogue.
function atCount(message: string, count: number): string {
  const branch = /other \{([^}]*)\}/.exec(message)?.[1] ?? message;
  return branch.replace("#", String(count));
}

/**
 * The band the width displays. On the members and webhooks screens the
 * laptop's table and the phone's cards are both in the DOM at every width, cut
 * apart by CSS alone, so a locator that names no band reaches a row twice and
 * dies on strict mode.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

test("the categories screen renders the categories it read", async ({ page }) => {
  await page.goto("/es/settings/categories");

  // Categorías gained a laptop band of its own (RF-63, RF-116): the phone's
  // card and the table's row both carry the bare name, so this scopes the read
  // to whichever the width is showing, in line rather than a shared helper.
  const shown = page.locator("main > div > .rt-Box").filter({ visible: true });
  await expect(shown.getByText(scope.categoryName, { exact: true })).toBeVisible();

  // The phone states the count as a phrase inside the category's own card; the
  // laptop states it as a bare figure in the row's own column (SPEC-A3). Either
  // way this is the one node naming this category's own count, not whichever
  // other childless category the run left standing.
  const subcategoryCount = shown
    .getByText(atCount(messages.categories.subcategoryCount, 0), {
      exact: true,
    })
    .or(
      shown
        .getByRole("row")
        .filter({ hasText: scope.categoryName })
        .getByRole("cell")
        .nth(2)
        .getByText("0", { exact: true }),
    );

  await expect(subcategoryCount).toBeVisible();
});

test("the labels screen renders a label with its usage counts", async ({
  page,
}) => {
  const labelId = randomUUID();
  const name = `Etiqueta ajustes ${stamp}`;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into labels (id, owner_user_id, name, color)
      values (${labelId}, ${scope.userId}, ${name}, '#4C8C4A')`;
  });

  await page.goto("/es/settings/labels");

  // Etiquetas gained the same laptop band (RF-70, RF-116); see the categories
  // test above for why this reads in line rather than through a shared helper.
  const shown = page.locator("main > div > .rt-Box").filter({ visible: true });
  await expect(shown.getByText(name, { exact: true })).toBeVisible();

  // The row this label's own two counts ride, in whichever band is shown —
  // there is no other label on this screen to confuse it with.
  const row = shown.getByRole("row").filter({ hasText: name });

  await expect(
    shown
      .getByText(atCount(messages.labels.usageCount, 0), { exact: true })
      .or(row.getByRole("cell").nth(2).getByText("0", { exact: true })),
  ).toBeVisible();
  await expect(
    shown
      .getByText(atCount(messages.labels.budgetCount, 0), { exact: true })
      .or(row.getByRole("cell").nth(3).getByText("0", { exact: true })),
  ).toBeVisible();

  await fixtureSql`delete from labels where id = ${labelId}`;
});

test.describe("the audit screen", () => {
  const categoryId = randomUUID();

  // The trail answers only to its triggers (RF-44), so a write is the only way
  // to put a row on this screen; the id it stamps is what the table shows.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${categoryId}, ${scope.userId}, ${`Auditoría ${stamp}`}, 'expense', '#4C8C4A')`;
    });
  });

  // The drop rides a hook rather than the end of the test: a category this one
  // leaves alive when it fails is a second '0 subcategorías' for the categories
  // test above, which turns one red into two and hides which was the real one.
  test.afterEach(async () => {
    await fixtureSql`delete from categories where id = ${categoryId}`;
  });

  test("lists the record a write just left", async ({ page }) => {
    await page.goto("/es/settings/audit");

    // Newest first, so the row this test wrote is on the first page.
    await expect(page.getByRole("cell", { name: categoryId })).toBeVisible();
  });
});

test("the data screen carries every exportable entity into its download link", async ({
  page,
}) => {
  await page.goto("/es/settings/data");

  // The entity list is a server constant: the href is where it lands, and an
  // empty one would silently export everything instead. `URLSearchParams` writes
  // the separators percent-encoded, which is what the route reads back.
  const link = page.getByRole("link", {
    name: messages.data.screen.download,
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    "/es/settings/data/export?entities=accounts%2Cmembers%2Ccategories%2CrecurringRules%2Ctransactions",
  );
});

test("the webhooks screen renders a credential with its own rate limit", async ({
  page,
}) => {
  const credentialId = randomUUID();
  const name = `Credencial ajustes ${stamp}`;
  const rateLimit = 37;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into webhook_credentials (
        id, owner_user_id, name, token_hash, rate_limit_per_min)
      values (
        ${credentialId}, ${scope.userId}, ${name},
        ${createHash("sha256").update(credentialId).digest("hex")}, ${rateLimit})`;
  });

  await page.goto("/es/settings/webhooks");

  await expect(band(page).getByText(name, { exact: true })).toBeVisible();
  await expect(
    band(page).getByText(atCount(messages.webhooks.rateLimit, rateLimit), {
      exact: true,
    }),
  ).toBeVisible();

  await fixtureSql`delete from webhook_credentials where id = ${credentialId}`;
});

test.describe("the members screen", () => {
  const groupId = randomUUID();
  const leaderId = randomUUID();
  const memberId = randomUUID();
  const leaderName = "Harness leader";
  const memberName = `Miembro ajustes ${stamp}`;

  // A personal-only caller has no roster to read, so this screen needs a fund.
  // The hooks own it on both ends: a group left behind would move every other
  // screen's scope from personal to group.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into groups (id, name, cash_mode)
        values (${groupId}, ${`Fondo ajustes ${stamp}`}, 'per_member')`;
      await tx`
        insert into group_members (id, group_id, user_id, name, role)
        values (${leaderId}, ${groupId}, ${scope.userId}, ${leaderName}, 'leader')`;
      await tx`
        insert into group_members (id, group_id, name, role)
        values (${memberId}, ${groupId}, ${memberName}, 'member')`;
    });
  });

  test.afterEach(async () => {
    // Under the caller's claims, so the trail rows this drop stamps name an actor
    // the next run's purge can find again.
    await asHarnessUser(async (tx) => {
      await tx`delete from groups where id = ${groupId}`;
      await tx`delete from group_members where group_id = ${groupId}`;
    });
  });

  test("renders the roster of the caller's fund", async ({ page }) => {
    await page.goto("/es/settings/members");

    // The sidebar names the signed-in person, so their name is on the screen
    // twice by design; the roster is the one under test, in the band this
    // width displays — the other band carries the same names, hidden.
    const roster = band(page);

    await expect(roster.getByText(memberName, { exact: true })).toBeVisible();
    await expect(roster.getByText(leaderName, { exact: true })).toBeVisible();
    // The invited member has claimed no login yet, which the row says out loud.
    await expect(
      roster.getByText(messages.members.noLoginBadge, { exact: true }),
    ).toBeVisible();
  });
});

// The menu names its own row, so match the prefix: the count is what says how
// many rows carry a menu at all, and the rename below says which row it was.
function rowMenus(page: Page): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.split("{")[0].trim(),
  });
}

// Whichever of the two the browser signs in as is named by the sidebar as well,
// so both rows are read from the band this width displays, not the sidebar's.
async function expectRosterRendered(page: Page): Promise<void> {
  const roster = band(page);

  await expect(roster.getByText(LEADER_MEMBER_NAME, { exact: true })).toBeVisible();
  await expect(roster.getByText(PLAIN_MEMBER_NAME, { exact: true })).toBeVisible();
}

// Whose row an open menu belonged to: the name its rename arrives prefilled with.
async function expectRenameSubject(page: Page, name: string): Promise<void> {
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: common.edit, exact: true })
    .click();

  await expect(
    page.getByRole("dialog").getByRole("textbox", { name: members.nameLabel }),
  ).toHaveValue(name);
}

test.describe("RF-100 on the roster", () => {
  // The two identities and their one group, held for these describes alone: a
  // group alive during the tests above would move their scope from personal to
  // the fund's, and the categories screen reads a different set under each.
  test.beforeAll(async () => {
    await seedGroup();
  });

  test.afterAll(async () => {
    await clearGroup();
  });

  test.describe("the members roster under its leader", () => {
    test("offers the add control and a menu over another member's row", async ({
      page,
    }) => {
      await page.goto("/es/settings/members");
      await expectRosterRendered(page);

      await expect(
        page.getByRole("button", { name: members.add, exact: true }),
      ).toBeVisible();

      await expect(rowMenus(page)).toHaveCount(2);

      // The second row by name is the plain member's, which is not the leader's own.
      await rowMenus(page).nth(1).click();
      // The transfer sits between the rename and the archive on a live member
      // who has a login, and on no other row (RF-59).
      await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
        common.edit,
        members.transfer,
        common.archive,
        common.delete,
      ]);

      await expectRenameSubject(page, PLAIN_MEMBER_NAME);
    });
  });

  test.describe("the members roster under a plain member", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("renders the roster and offers no add control", async ({ page }) => {
      await page.goto("/es/settings/members");
      await expectRosterRendered(page);

      await expect(
        page.getByRole("button", { name: members.add, exact: true }),
      ).toHaveCount(0);
    });

    test("offers one menu, over their own row, and it renames and nothing else", async ({
      page,
    }) => {
      await page.goto("/es/settings/members");
      await expectRosterRendered(page);

      // Two rows, one menu: the other member's row carries none.
      await expect(rowMenus(page)).toHaveCount(1);

      await rowMenus(page).click();
      await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
        common.edit,
      ]);

      await expectRenameSubject(page, PLAIN_MEMBER_NAME);
    });
  });
});

test.describe("the group's own settings", () => {
  // The one test that writes rewrites this group, and `seedGroup` opens by
  // dropping whatever the last one left, so either test meets the fund named and
  // moded as it was seeded whichever order they run in.
  let groupId = "";

  test.beforeEach(async () => {
    ({ groupId } = await seedGroup());
  });

  test.afterAll(async () => {
    await clearGroup();
  });

  test("saves the leader's name and cash mode, and the switch leaves the group one cash", async ({
    page,
  }) => {
    const renamed = `Fondo renombrado ${stamp}`;

    // The seeded row is what the fields are read against: a change only proves
    // anything once the screen is carrying the three values it was given.
    const [seeded] = await fixtureSql<
      { name: string; cash_mode: string; currency: string }[]
    >`select name, cash_mode, currency from groups where id = ${groupId}`;
    expect(seeded.cash_mode).toBe("per_member");
    expect(seeded.currency).toBe("COP");
    // Cash per member holds no shared pot, so the one below is the switch's own
    // work and not a row the seed left lying there.
    expect(
      await fixtureSql`select id from accounts where group_id = ${groupId}`,
    ).toHaveLength(0);

    await page.goto("/es/settings/group");

    await expect(page.getByRole("textbox", { name: group.nameLabel })).toHaveValue(
      seeded.name,
    );
    await expect(
      page.getByRole("radio", { name: group.cashModePerMember, exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("radio", { name: "COP", exact: true }),
    ).toBeChecked();

    await page.getByRole("textbox", { name: group.nameLabel }).fill(renamed);
    await page
      .getByRole("radio", { name: group.cashModeShared, exact: true })
      .click();
    // The currency rides the same one-statement write as the name and the cash
    // mode (RF-121): a leader changes where the fund settles from here too.
    await page.getByRole("radio", { name: "USD", exact: true }).click();
    await page.getByRole("button", { name: group.save, exact: true }).click();

    await expect(page.getByText(group.saved, { exact: true })).toBeVisible();

    const [saved] = await fixtureSql<
      { name: string; cash_mode: string; currency: string }[]
    >`select name, cash_mode, currency from groups where id = ${groupId}`;
    expect(saved.name).toBe(renamed);
    expect(saved.cash_mode).toBe("shared");
    expect(saved.currency).toBe("USD");

    // 'shared' names one pot, so the save has to leave exactly one behind (RF-56):
    // none sends the next withdrawal to an account nothing ever finds again, and
    // a second splits the cash the mode just merged. The name carries the locale
    // the form was submitted in, which is the request's, not the group's.
    const cash = await fixtureSql<{ name: string }[]>`
      select name from accounts
      where group_id = ${groupId} and subtype = 'efectivo' and archived_at is null`;
    expect(cash).toHaveLength(1);
    expect(cash[0].name).toBe(GROUP_CASH_ACCOUNT_NAME.es);
  });

  test.describe("under a plain member", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("reads the two values and is offered no way to write them", async ({
      page,
    }) => {
      const [seeded] = await fixtureSql<{ name: string }[]>`
        select name from groups where id = ${groupId}`;

      await page.goto("/es/settings/group");

      // The sidebar names the fund too, so the pair is read from the screen's
      // own landmark.
      const settings = page.getByRole("main");

      await expect(settings.getByText(seeded.name, { exact: true })).toBeVisible();
      await expect(
        settings.getByText(group.cashModePerMember, { exact: true }),
      ).toBeVisible();
      // The currency reads as plain text here, the same way the cash mode does
      // above — no member changes where the fund settles (RF-121).
      await expect(settings.getByText("COP", { exact: true })).toBeVisible();

      // RF-57: the configuration is the leader's, and this screen hands a plain
      // member neither the field nor the button that would reach the action.
      await expect(
        page.getByRole("textbox", { name: group.nameLabel }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("radio", { name: "USD", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: group.save, exact: true }),
      ).toHaveCount(0);
    });
  });
});
