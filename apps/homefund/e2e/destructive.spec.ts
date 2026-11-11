/**
 * The removal paths, which nothing else in the harness reaches. Layer 1 drives
 * the query function under an action; only a browser drives the form, the
 * `authActionClient` middleware, the server's own re-validation, the DELETE
 * grant and the policy together — and DELETE is a grant of its own, so a missing
 * one ships green everywhere else.
 *
 * Every test creates its subject through the interface, reads it back on screen,
 * removes it through the real confirmation and then asserts the row is gone from
 * Postgres. The copy is read from the message file the screen reads, so a
 * rewording moves both at once.
 *
 * Two of them run a removal the other way round: the row goes while a form on
 * another screen still offers it, and what is asserted is the sentence the
 * refused write puts on screen.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { readScope, test } from "./global-setup";

const common = messages.common;
const scope = readScope();

// Unique per run, so a name asserted on screen can only be this test's row.
const stamp = randomUUID().slice(0, 8);

// An empty screen renders its add control twice — once in the header, once as the
// empty state's action — and both open the same form.
function addButton(page: Page, label: string): Locator {
  return page.getByRole("button", { name: label, exact: true }).first();
}

// Every row on these screens carries the same trigger, which names its own row
// now, so match the prefix and let a test pin how many rows it expects.
function rowMenus(page: Page): Locator {
  return page.getByRole("button", { name: common.actionsFor.split("{")[0].trim() });
}

/**
 * The band the width displays. On every screen that gained a dense table,
 * the laptop's rows and the phone's cards are both in the DOM at every width,
 * cut apart by CSS alone, so a name looked for on the screen reaches two nodes
 * and dies on strict mode.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

/**
 * Runs a row's destructive item through the confirmation it raises. The menu and
 * the `ConfirmDialog` are the same pair on every screen here; only the two
 * labels change.
 */
async function confirmThroughMenu(
  page: Page,
  trigger: Locator,
  menuItem: string,
  confirmLabel: string,
): Promise<void> {
  await trigger.click();
  await page.getByRole("menuitem", { name: menuItem, exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

// The one-row case, which is every screen below but the members roster.
async function removeOnlyRow(
  page: Page,
  menuItem: string,
  confirmLabel: string,
): Promise<void> {
  const trigger = rowMenus(page);
  await expect(trigger).toHaveCount(1);
  await confirmThroughMenu(page, trigger, menuItem, confirmLabel);
}

test("creates a category and deletes it from the screen and the table", async ({
  page,
}) => {
  const categories = messages.categories;
  const name = `Categoría ${stamp}`;

  // The income tab: the seeded scope category is an expense, so this tab holds
  // exactly the one row this test writes.
  await page.goto("/es/settings/categories?kind=income");
  await addButton(page, categories.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: categories.nameLabel }).fill(name);
  await form.getByRole("button", { name: common.save, exact: true }).click();

  await expect(form).toBeHidden();
  // Categorías has a laptop band of its own (RF-63): a bare name
  // matches the phone's card and the table's row alike, so the check names the
  // one the width is showing.
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  const [created] = await fixtureSql<{ id: string; kind: string }[]>`
    select id, kind from categories
    where owner_user_id = ${scope.userId} and name = ${name}`;
  expect(created.kind).toBe("income");

  await removeOnlyRow(page, common.delete, common.delete);

  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  const left = await fixtureSql`select id from categories where id = ${created.id}`;
  expect(left).toHaveLength(0);
});
