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
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { clearGroup, readScope, test } from "./global-setup";

const accounts = messages.accounts;
const common = messages.common;

const scope = readScope();

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

test("draws every account the caller owns with no placement word and no fund band", async ({
  page,
}) => {
  const names = await personalAccountNames();
  expect(names.length).toBeGreaterThan(0);

  await page.goto("/es/settings/accounts");

  // One menu per account: a band this caller cannot own would bring rows with it.
  await expect(
    page.getByRole("button", { name: common.actionsFor.split("{")[0].trim() }),
  ).toHaveCount(names.length);

  // Every account is personal, so nothing says so (RF-240): no «Personal» mark or band, and no fund band, whose own
  // label is what the screen falls back to when a group has no name to give it. Group-less neither is ever drawn.
  const main = page.getByRole("main");
  await expect(main.getByText(accounts.ownerPersonal, { exact: true })).toHaveCount(0);
  await expect(main.getByText(common.fund, { exact: true })).toHaveCount(0);
  await expect(main.getByRole("img", { name: accounts.ownerPersonal })).toHaveCount(0);
});
