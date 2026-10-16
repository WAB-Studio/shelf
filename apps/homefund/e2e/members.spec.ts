/**
 * RF-59 and RF-11 on the roster, driven the way a person reaches them. Both were
 * proved once in a throwaway script; this is what will catch them tomorrow.
 *
 * The transfer is a swap nothing on screen can show in one place: the badge moves
 * to the other person and the caller's own row loses everything but the rename,
 * while the two `role` columns change in the same statement. Both halves are
 * asserted, and the columns are read from Postgres rather than inferred from the
 * screen that ordered the change.
 *
 * The delete refusal is the other direction: RF-11 says a member whose person left
 * an economic trace is archived, never deleted, and the only proof that holds is
 * a confirmed delete that answers in words and leaves the row where it was.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  LEADER_MEMBER_NAME,
  MEMBER_STORAGE_STATE,
  PLAIN_MEMBER_NAME,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const members = messages.members;
const common = messages.common;
const errors = messages.errors;
const nav = messages.nav;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

// The menu names the row it belongs to, so a row is reached by its own name and
// never by a position among whatever else the roster is carrying.
function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

// The band the width displays. The laptop's table and the phone's cards are both
// in the DOM at every width, cut apart by CSS alone, so a locator that names no
// band reaches a member twice and dies on strict mode.
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The line a member's name sits on, badges included. The laptop's table splits
// a member across cells — the role badge sits in its own column, apart from the
// name — so only the whole `role="row"` carries both; the phone's card keeps
// every badge in the one div the name sits in, and the table matches nothing
// there for `getByRole` to find, so the card's own div takes over. Waits for
// the roster's own copy of the name first, scoped to the band, never to
// `page`: the sidebar carries the caller's own name too, already visible
// before the roster paints, and a page-wide wait would resolve on that one and
// race the count below into the wrong branch — the mobile sidebar hides it
// outright, so the same wait would just hang.
async function nameRow(page: Page, name: string): Promise<Locator> {
  await band(page).getByText(name).first().waitFor();

  const row = page
    .getByRole("table", { name: members.title })
    .getByRole("row")
    .filter({ hasText: name });
  if ((await row.count()) > 0) return row;

  return band(page).locator("div").filter({ hasText: name }).last();
}

// The labels an open row menu offers, which is what says who may do what (RF-100,
// RF-59). Closing it again leaves the next row's menu reachable.
async function menuItems(page: Page, name: string): Promise<string[]> {
  await rowMenu(page, name).click();
  const items = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  return items.map((item) => item.trim());
}

/** Runs a row's menu item through the confirmation it raises. */
async function confirmThroughMenu(
  page: Page,
  name: string,
  menuItem: string,
  confirmLabel: string,
): Promise<Locator> {
  await rowMenu(page, name).click();
  await page.getByRole("menuitem", { name: menuItem, exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();

  return dialog;
}

// Both roles of the seeded group, keyed by the user holding them.
async function rolesByUser(groupId: string): Promise<Record<string, string>> {
  const rows = await fixtureSql<{ user_id: string; role: string }[]>`
    select user_id, role from group_members
    where group_id = ${groupId} and user_id is not null`;

  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

let groupId = "";

// Every test starts from the seeded roster: the first one moves the role off the
// harness user, and the rest need it back.
test.beforeEach(async () => {
  ({ groupId } = await seedGroup());
});

test.afterAll(async () => {
  await clearGroup();
});

test("moves the leader role to the member a leader picks, and steps the caller down", async ({
  page,
}) => {
  const before = await rolesByUser(groupId);
  expect(before[scope.userId]).toBe("leader");
  expect(before[scope.memberUserId]).toBe("member");

  await page.goto("/es/settings/members");
  await expect(await nameRow(page, LEADER_MEMBER_NAME)).toContainText(
    members.ownerBadge,
  );

  await rowMenu(page, PLAIN_MEMBER_NAME).click();
  await page
    .getByRole("menuitem", { name: members.transfer, exact: true })
    .click();

  // A person about to stop leading has to read that before they press (RF-59).
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(members.transferDescription);
  await dialog
    .getByRole("button", { name: members.transfer, exact: true })
    .click();

  await expect(page.getByText(members.transferred, { exact: true })).toBeVisible();

  // The swap, from the columns and not from the screen that ordered it: one call
  // raised the target and lowered the caller, and the group holds one leader.
  await expect
    .poll(async () => await rolesByUser(groupId))
    .toEqual({ [scope.userId]: "member", [scope.memberUserId]: "leader" });

  await expect(await nameRow(page, PLAIN_MEMBER_NAME)).toContainText(
    members.ownerBadge,
  );
  await expect(await nameRow(page, LEADER_MEMBER_NAME)).not.toContainText(
    members.ownerBadge,
  );

  // The caller leads nothing now, so their own row is the only one with a menu
  // and all it still offers is the rename.
  await expect(rowMenu(page, PLAIN_MEMBER_NAME)).toHaveCount(0);
  expect(await menuItems(page, LEADER_MEMBER_NAME)).toEqual([common.edit]);
  await expect(page.getByText(members.transfer, { exact: true })).toHaveCount(0);
});

test("names the one fund the caller belongs to and offers no way to a second", async ({
  page,
}) => {
  const [fund] = await fixtureSql<{ name: string }[]>`
    select name from groups where id = ${groupId}`;

  await page.goto("/es/settings/members");

  // RF-55: a membership is exclusive, so the shell has one fund to name. Two
  // surfaces carry it — the sidebar's row and the phone's header — and CSS shows
  // whichever this viewport is; a switcher would be a third.
  await expect(page.getByText(fund.name, { exact: true })).toHaveCount(2);
  await expect(
    page.getByText(fund.name, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);

  // The one control on that row goes to this fund's own settings, not to another.
  await expect(page.getByLabel(nav.fundSettings)).toHaveAttribute(
    "href",
    "/es/settings/group",
  );
});

test.describe("under a plain member", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("offers the transfer on no row of the roster", async ({ page }) => {
    await page.goto("/es/settings/members");
    await expect(
      band(page).getByText(LEADER_MEMBER_NAME, { exact: true }),
    ).toBeVisible();

    // Two rows, one menu: only their own, and only to rename it (RF-100).
    await expect(rowMenu(page, LEADER_MEMBER_NAME)).toHaveCount(0);
    expect(await menuItems(page, PLAIN_MEMBER_NAME)).toEqual([common.edit]);
    await expect(page.getByText(members.transfer, { exact: true })).toHaveCount(0);
  });
});

test("refuses to delete a member whose person owns an account, and says so", async ({
  page,
}) => {
  const accountId = randomUUID();
  const claims = JSON.stringify({
    sub: scope.memberUserId,
    role: "authenticated",
    aud: "authenticated",
  });

  // The account belongs to the second identity, which is the row the leader is
  // about to try to delete. Written under its own claims so the stamping triggers
  // see them; the purge only reaches the first identity, so this spec drops it.
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype,
        initial_balance_cents, initial_balance_on)
      values (
        ${accountId}, ${scope.memberUserId}, ${`Cuenta del miembro ${stamp}`},
        'asset', 'bancaria', 1000000, (now() at time zone ${TIME_ZONE})::date)`;
  });

  const [target] = await fixtureSql<{ id: string; archived_at: string | null }[]>`
    select id, archived_at::text as archived_at from group_members
    where group_id = ${groupId} and user_id = ${scope.memberUserId}`;

  await page.goto("/es/settings/members");
  const dialog = await confirmThroughMenu(
    page,
    PLAIN_MEMBER_NAME,
    common.delete,
    common.delete,
  );

  // RF-11: the refusal is copy a person can act on, not a database message.
  await expect(page.getByText(errors.memberHasHistory, { exact: true })).toBeVisible();

  // A refused confirmation stays open, which is what keeps the roster under an
  // `aria-hidden` a role locator would not reach.
  await dialog.getByRole("button", { name: common.cancel, exact: true }).click();
  await expect(dialog).toBeHidden();

  // And the row is where it was, on screen and in Postgres, archived_at included:
  // a refusal that quietly archived instead would read the same on screen.
  await expect(
    band(page).getByText(PLAIN_MEMBER_NAME, { exact: true }),
  ).toBeVisible();
  const survivors = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from group_members where id = ${target.id}`;
  expect(survivors).toHaveLength(1);
  expect(survivors[0].archived_at).toBe(target.archived_at);

  await fixtureSql`delete from accounts where id = ${accountId}`;
});
