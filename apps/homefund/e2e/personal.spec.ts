/**
 * RF-55 from the side no spec had ever run: a person who belongs to no group.
 * Every other suite seeds one, so the app's group-less shape — the default one,
 * and the one every new account starts in — was only ever asserted by a route
 * answering 200.
 *
 * What it has to hold is negative throughout: one placement, one fund name, no
 * roster and nothing anywhere that offers a second fund or a way between two.
 * The harness identity holds no membership by default; `clearGroup()` restates
 * that so this spec never inherits another one's.
 */
import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { clearGroup, readScope, test } from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;
const nav = messages.nav;

const scope = readScope();

// The shell falls back to the product's own name when there is no fund to name.
const FUND_NAME = common.appName;

/**
 * The band the width displays. The laptop's table and the phone's cards are both
 * in the DOM at every width, cut apart by CSS alone, so a locator that names no
 * band reaches an account twice.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The two sides an account may be drawn on. Group-less only one is ever drawn,
// and that is the assertion.
type Placement = "personal" | "fund";

/**
 * The placement the displayed band states for an account. The phone heads a run
 * of cards with it, so it is the last band to appear above the card; the
 * laptop's table gives every row a scope cell under the name instead, and
 * nothing at all precedes the first row's.
 */
async function placementOf(page: Page, name: string): Promise<Placement | null> {
  const rows = page
    .getByRole("table", { name: accounts.title })
    .getByRole("row")
    .filter({ hasText: name });

  if ((await rows.count()) > 0) {
    const placement = await rows.getByRole("cell").first().innerText();
    if (placement.includes(accounts.ownerFund)) return "fund";

    return placement.includes(accounts.ownerPersonal) ? "personal" : null;
  }

  const text = await band(page).innerText();
  const at = text.indexOf(name);
  if (at < 0) return null;

  const bands = [
    [accounts.ownerPersonal, "personal"],
    [common.fund, "fund"],
  ] as const;

  return (
    bands
      .map(([label, placement]) => ({ placement, at: text.lastIndexOf(label, at) }))
      .filter((one) => one.at >= 0)
      .sort((a, b) => a.at - b.at)
      .at(-1)?.placement ?? null
  );
}

// The caller's own live accounts, which group-less is every account they may read.
async function personalAccountNames(): Promise<string[]> {
  const rows = await fixtureSql<{ name: string }[]>`
    select name from accounts
    where owner_user_id = ${scope.userId} and archived_at is null
    order by name`;

  return rows.map((row) => row.name);
}

test.beforeAll(async () => {
  await clearGroup();
});

test("draws every account the caller owns under one placement and no fund band", async ({
  page,
}) => {
  const names = await personalAccountNames();
  expect(names.length).toBeGreaterThan(0);

  await page.goto("/es/settings/accounts");

  // One menu per account: a band this caller cannot own would bring rows with it.
  await expect(
    page.getByRole("button", { name: common.actionsFor.split("{")[0].trim() }),
  ).toHaveCount(names.length);

  for (const name of names) {
    expect(await placementOf(page, name)).toBe("personal");
  }

  // The fund band's own label, which is what the screen falls back to when a
  // group has no name to give it. Group-less it is never drawn.
  await expect(
    page.getByRole("main").getByText(common.fund, { exact: true }),
  ).toHaveCount(0);
});

test("offers no placement control on the account form", async ({ page }) => {
  await page.goto("/es/settings/accounts");
  await page.getByRole("button", { name: accounts.add, exact: true }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: accounts.nameLabel })).toBeVisible();

  // RF-60: the placement is a choice only a caller with a group has, and the
  // form drops the control rather than offering an option that cannot land.
  await expect(
    dialog.getByRole("combobox", { name: accounts.ownerLabel }),
  ).toHaveCount(0);
  await expect(dialog.getByText(accounts.ownerLabel, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(accounts.ownerFund, { exact: true })).toHaveCount(0);
});

test("offers no hand-over on a row that has nowhere to hand it", async ({ page }) => {
  const [name] = await personalAccountNames();

  await page.goto("/es/settings/accounts");
  await page
    .getByRole("button", {
      name: common.actionsFor.replace("{name}", name),
      exact: true,
    })
    .click();

  // RF-61 needs a group to hand an account to; without one the row keeps the
  // three actions it always had and gains nothing.
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
    common.edit,
    messages.accounts.reconcile,
    common.archive,
    common.delete,
  ]);
});

test("answers the members route with a 404", async ({ page }) => {
  const response = await page.goto("/es/settings/members");

  // A roster lives inside a group, and a caller without one has none to read
  // (RF-55). The status is the assertion: a screen that rendered empty over a
  // 200 would look the same and mean something else.
  expect(response?.status()).toBe(404);
  await expect(
    page.getByText(messages.errors.notFoundTitle, { exact: true }),
  ).toBeVisible();
});

test("names one fund in the shell and offers no way to a second", async ({ page }) => {
  await page.goto("/es/settings/accounts");

  // Two surfaces carry the name — the sidebar's row and the phone's header — and
  // CSS shows whichever this viewport is. A switcher would be a third.
  await expect(page.getByText(FUND_NAME, { exact: true })).toHaveCount(2);
  await expect(
    page.getByText(FUND_NAME, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);

  // Nothing to configure and nothing to switch to: the group's own settings are
  // the only thing the fund row ever links to, and it has no group.
  await expect(page.getByLabel(nav.fundSettings)).toHaveCount(0);
  await expect(page.getByRole("link", { name: nav.members, exact: true })).toHaveCount(
    0,
  );
});
