/**
 * RF-120 driven the way a person reaches it: a budget and a goal are created
 * through their own form, archived from the row menu, found again under the
 * archived tab and restored from there. Nothing else in the harness runs this
 * path — `archived_at` is a column of its own in the UPDATE grant, and the
 * archived tab is a second read with a second policy, so a screen that lists an
 * archived row on the active side ships green everywhere but here.
 *
 * The goal carries an opening aporte on purpose: archiving must move the row and
 * nothing else, so the figure it was saving is asserted before and after.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const budgets = messages.budgets;
const goals = messages.goals;
const common = messages.common;

const scope = readScope();

// Unique per run, so a name asserted on screen can only be this test's row.
const stamp = randomUUID().slice(0, 8);

// An empty screen renders its add control twice — once in the header, once as the
// empty state's action — and both open the same form.
function addButton(page: Page, label: string): Locator {
  return page.getByRole("button", { name: label, exact: true }).first();
}

// The menu names the row it belongs to, so a row is reached by its own title and
// never by a position among whatever else the list is carrying.
function rowMenu(page: Page, title: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", title),
    exact: true,
  });
}

// The two tabs are one segmented control, which Radix renders as radios.
function tab(page: Page, label: string): Locator {
  return page.getByRole("radio", { name: label, exact: true });
}

/**
 * The band the width displays. The laptop's table and the phone's cards are both
 * in the DOM at every width, cut apart by CSS alone, so a title looked for on the
 * screen reaches two nodes and dies on strict mode.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

/**
 * Runs a row's menu item through the confirmation it raises. Archiving and
 * restoring share the pair on both screens; only the two labels change.
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

test("archives a budget out of the active list and restores it from the archive", async ({
  page,
}) => {
  // Its own name, so the card is titled by this test's row rather than by the
  // category it shares with everything else the seed files there.
  const name = `Presupuesto archivable ${stamp}`;
  const limitPesos = "50000";

  await page.goto("/es/planning/budgets");
  await addButton(page, budgets.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("combobox", { name: budgets.categoryLabel }).click();
  // The option list is portalled out of the dialog.
  await page.getByRole("option", { name: scope.categoryName, exact: true }).click();
  await form.getByRole("textbox", { name: budgets.nameLabel }).fill(name);
  await form.getByRole("textbox", { name: budgets.limitLabel }).fill(limitPesos);
  await form.getByRole("button", { name: budgets.save, exact: true }).click();

  await expect(form).toBeHidden();
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  const [created] = await fixtureSql<{ id: string }[]>`
    select id from budgets
    where owner_user_id = ${scope.userId} and name = ${name}`;

  await confirmThroughMenu(page, rowMenu(page, name), common.archive, common.archive);

  await expect(band(page).getByText(name, { exact: true })).toHaveCount(0);
  const [archived] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from budgets where id = ${created.id}`;
  expect(archived.archived_at).not.toBeNull();

  // The archive is the other half of RF-120: leaving the active list is not
  // disappearing, and this tab is where the row has to be readable.
  await tab(page, budgets.archivedTab).click();
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  await confirmThroughMenu(page, rowMenu(page, name), common.restore, common.restore);

  await expect(band(page).getByText(name, { exact: true })).toHaveCount(0);
  await tab(page, budgets.activeTab).click();
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  const [restored] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from budgets where id = ${created.id}`;
  expect(restored.archived_at).toBeNull();

  await fixtureSql`delete from budgets where id = ${created.id}`;
});

/**
 * What the goal has apartado, as the shape this project's viewport renders shows
 * it: the laptop's own column in the row named by the goal, the phone's card line
 * beside the word. Both shapes stay mounted at every width and CSS displays one
 * of them, so the phone's locator drops the copy it is not looking at.
 */
function apartado(page: Page, desktop: boolean, name: string): Locator {
  if (!desktop) return page.getByText(goals.apartado).filter({ visible: true });

  return page
    .getByRole("table", { name: goals.title })
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("cell")
    .nth(3);
}

test("archives a savings goal and restores it still saving the same amount", async ({
  page,
}, testInfo) => {
  const name = `Meta archivable ${stamp}`;
  const targetPesos = "2000000";
  const openingPesos = "500000";
  const openingCents = 50000000;

  // A role matches only the shape on screen, so the goal is found by its own
  // menu rather than by a name both shapes carry in the markup.
  const desktop = testInfo.project.name === "desktop";
  const goalRow = () => rowMenu(page, name);

  await page.goto("/es/planning/goals");
  await addButton(page, goals.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: goals.nameLabel }).fill(name);
  await form.getByRole("textbox", { name: goals.targetLabel }).fill(targetPesos);
  await form
    .getByRole("textbox", { name: goals.initialContributionLabel })
    .fill(openingPesos);
  await form.getByRole("button", { name: goals.save, exact: true }).click();

  await expect(form).toBeHidden();
  await expect(goalRow()).toBeVisible();

  const [created] = await fixtureSql<{ id: string }[]>`
    select id from savings_goals
    where owner_user_id = ${scope.userId} and name = ${name}`;

  // Read from the screen, not computed: what a person has to find unchanged is
  // the figure the screen is showing them.
  const savedOnScreen = (await apartado(page, desktop, name).textContent()) ?? "";
  expect(await savedCents(created.id)).toBe(openingCents);

  await confirmThroughMenu(page, rowMenu(page, name), common.archive, common.archive);

  await expect(goalRow()).toHaveCount(0);
  const [archived] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from savings_goals where id = ${created.id}`;
  expect(archived.archived_at).not.toBeNull();

  await tab(page, goals.archivedTab).click();
  await expect(goalRow()).toBeVisible();

  await confirmThroughMenu(page, rowMenu(page, name), common.restore, common.restore);

  await expect(goalRow()).toHaveCount(0);
  await tab(page, goals.activeTab).click();
  await expect(goalRow()).toBeVisible();

  const [restored] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from savings_goals where id = ${created.id}`;
  expect(restored.archived_at).toBeNull();

  // Archiving moves the row and nothing else: the aportes it derives from were
  // never touched, so both the screen and the cents behind it read as they did.
  await expect(apartado(page, desktop, name)).toHaveText(savedOnScreen);
  expect(await savedCents(created.id)).toBe(openingCents);

  // The aporte is named before its goal even though it cascades: one that
  // outlived its goal would be a leak no later count could explain. Under the
  // caller's claims, so the trail rows this drop stamps name an actor the next
  // run's purge can find again.
  await asHarnessUser(async (tx) => {
    await tx`delete from goal_contributions where goal_id = ${created.id}`;
    await tx`delete from savings_goals where id = ${created.id}`;
  });
});

// What the goal has set aside, summed from the aportes the progress derives from
// (RF-87), in the integer cents they are stored as.
async function savedCents(goalId: string): Promise<number> {
  const [row] = await fixtureSql<{ saved: string }[]>`
    select coalesce(sum(amount_cents), 0)::text as saved
    from goal_contributions where goal_id = ${goalId}`;

  return Number(row.saved);
}
