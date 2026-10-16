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
import { createHash, randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

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
  // Categorías gained a laptop band of its own (RF-63, RF-116): a bare name
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

test("creates a label and deletes it from the screen and the table", async ({
  page,
}) => {
  const labels = messages.labels;
  const name = `Etiqueta ${stamp}`;

  await page.goto("/es/settings/labels");
  await addButton(page, labels.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: labels.nameLabel }).fill(name);
  await form.getByRole("button", { name: common.save, exact: true }).click();

  await expect(form).toBeHidden();
  // Etiquetas gained a laptop band of its own (RF-70, RF-116): a bare name
  // matches the phone's card and the table's row alike, so the check names the
  // one the width is showing.
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  const [created] = await fixtureSql<{ id: string }[]>`
    select id from labels
    where owner_user_id = ${scope.userId} and name = ${name}`;

  await removeOnlyRow(page, common.delete, common.delete);

  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  const left = await fixtureSql`select id from labels where id = ${created.id}`;
  expect(left).toHaveLength(0);
});

test("creates a budget and deletes it from the screen and the table", async ({
  page,
}) => {
  const budgets = messages.budgets;
  // A budget's card is titled by its category, so the category carries the name
  // this test asserts on.
  const categoryName = `Presupuesto ${stamp}`;
  const categoryId = randomUUID();
  const limitPesos = "137777";
  const limitCents = 13777700;

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${categoryName}, 'expense', '#4C8C4A')`;
  });

  await page.goto("/es/planning/budgets");
  await addButton(page, budgets.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("combobox", { name: budgets.categoryLabel }).click();
  // The option list is portalled out of the dialog.
  await page.getByRole("option", { name: categoryName, exact: true }).click();
  await form.getByRole("textbox", { name: budgets.limitLabel }).fill(limitPesos);
  await form.getByRole("button", { name: budgets.save, exact: true }).click();

  await expect(form).toBeHidden();
  await expect(band(page).getByText(categoryName, { exact: true })).toBeVisible();

  const [created] = await fixtureSql<{ id: string; limit_cents: string }[]>`
    select id, limit_cents::text as limit_cents from budgets
    where owner_user_id = ${scope.userId} and category_id = ${categoryId}`;
  expect(created.limit_cents).toBe(String(limitCents));

  await removeOnlyRow(page, common.delete, common.delete);

  await expect(band(page).getByText(categoryName, { exact: true })).toHaveCount(0);
  const left = await fixtureSql`select id from budgets where id = ${created.id}`;
  expect(left).toHaveLength(0);

  await fixtureSql`delete from categories where id = ${categoryId}`;
});

test("creates a savings goal and deletes it from the screen and the table", async ({
  page,
}) => {
  const goals = messages.goals;
  const name = `Meta ${stamp}`;
  const targetPesos = "2400000";
  const targetCents = 240000000;

  await page.goto("/es/planning/goals");
  await addButton(page, goals.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: goals.nameLabel }).fill(name);
  await form.getByRole("textbox", { name: goals.targetLabel }).fill(targetPesos);
  await form.getByRole("button", { name: goals.save, exact: true }).click();

  await expect(form).toBeHidden();
  // Metas draws a table on a laptop and cards on a phone, both mounted at every
  // width: a role matches only the shape on screen, a name matches both.
  const goalRow = page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
  await expect(goalRow).toBeVisible();

  const [created] = await fixtureSql<
    { id: string; target_amount_cents: string }[]
  >`
    select id, target_amount_cents::text as target_amount_cents from savings_goals
    where owner_user_id = ${scope.userId} and name = ${name}`;
  expect(created.target_amount_cents).toBe(String(targetCents));

  await removeOnlyRow(page, common.delete, common.delete);

  await expect(goalRow).toHaveCount(0);
  const left = await fixtureSql`select id from savings_goals where id = ${created.id}`;
  expect(left).toHaveLength(0);
});

test("creates a planned payment and deletes it from the screen and the table", async ({
  page,
}) => {
  const payments = messages.plannedPayments;
  const concept = `Pago ${stamp}`;
  const amountPesos = "890000";
  const amountCents = 89000000;
  // A reminder may fall in the future, and one that does keeps the row on the
  // pending list whatever day the run lands on.
  const dueDate = "2027-03-12";

  await page.goto("/es/planning/payments");
  await addButton(page, payments.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: payments.conceptLabel }).fill(concept);
  await form.getByRole("textbox", { name: payments.amountLabel }).fill(amountPesos);
  await form.getByRole("combobox", { name: payments.fromLabel }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  // A date input carries no textbox role, so it is reached by its label.
  await form.getByLabel(payments.dueLabel).fill(dueDate);
  await form.getByRole("button", { name: payments.save, exact: true }).click();

  await expect(form).toBeHidden();
  await expect(band(page).getByText(concept, { exact: true })).toBeVisible();

  const [created] = await fixtureSql<
    { id: string; amount_cents: string; due_date: string }[]
  >`
    select id, amount_cents::text as amount_cents, due_date::text as due_date
    from planned_payments
    where owner_user_id = ${scope.userId} and description = ${concept}`;
  expect(created.amount_cents).toBe(String(amountCents));
  expect(created.due_date).toBe(dueDate);

  await removeOnlyRow(page, common.delete, common.delete);

  await expect(band(page).getByText(concept, { exact: true })).toHaveCount(0);
  const left = await fixtureSql`select id from planned_payments where id = ${created.id}`;
  expect(left).toHaveLength(0);
});

test("creates a recurring rule and pauses it, the only write its card offers", async ({
  page,
}) => {
  const rules = messages.recurringRules;
  const concept = `Regla ${stamp}`;
  const amountPesos = "56000";
  const amountCents = 5600000;
  const nextRunOn = "2027-04-05";

  // The generated-movement fixture writes a rule of its own; cleared, so the
  // card this test writes is the only one on screen.
  await clearLedger();

  await page.goto("/es/planning/recurring");
  await addButton(page, rules.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: rules.conceptLabel }).fill(concept);
  await form.getByRole("textbox", { name: rules.amountLabel }).fill(amountPesos);
  await form.getByLabel(rules.nextRunLabel).fill(nextRunOn);
  await form.getByRole("combobox", { name: rules.accountLabel }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await form.getByRole("combobox", { name: rules.categoryLabel }).click();
  await page.getByRole("option", { name: scope.categoryName, exact: true }).click();
  await form.getByRole("button", { name: rules.save, exact: true }).click();

  await expect(form).toBeHidden();
  // The line each band names the rule on: the concept, with the Auto badge
  // beside it. The laptop leaves that cell no width of its own between the seven
  // fixed columns after it, so what the line says is the assertion.
  const named = band(page)
    .locator("div")
    .filter({ has: page.getByText(rules.autoBadge, { exact: true }) })
    .last();
  await expect(named).toHaveText(`${concept}${rules.autoBadge}`);

  const [created] = await fixtureSql<
    { id: string; amount_cents: string; is_active: boolean }[]
  >`
    select id, amount_cents::text as amount_cents, is_active from recurring_rules
    where owner_user_id = ${scope.userId} and description = ${concept}`;
  expect(created.amount_cents).toBe(String(amountCents));
  expect(created.is_active).toBe(true);

  // No card offers a rule's removal, so the pause switch is the only write left
  // to drive: `deleteRecurringRuleAction` has no caller in the interface.
  // Either band's switch: the card names it for the screen, the row for the rule.
  const toggle = page
    .getByRole("switch", { name: rules.activeToggle, exact: true })
    .or(
      page.getByRole("switch", {
        name: rules.pauseSwitchLabel.replace("{name}", concept),
        exact: true,
      }),
    );
  await expect(toggle).toHaveCount(1);
  await toggle.click();
  await expect(band(page).getByText(rules.statePaused, { exact: true })).toBeVisible();

  const [paused] = await fixtureSql<{ is_active: boolean }[]>`
    select is_active from recurring_rules where id = ${created.id}`;
  expect(paused.is_active).toBe(false);

  // Written through the interface and unreachable by any control on it, so it is
  // dropped here rather than by a screen.
  await fixtureSql`delete from recurring_rules where id = ${created.id}`;
});

/**
 * The other side of a removal: a row deleted while someone else's form still
 * offers it. The write that names it is the only way the app reaches 23503 on a
 * planning screen — an account gone fails the INSERT policy first, and a split's
 * category is caught by a trigger, so the category of a planned payment is what
 * is left. The refusal has to read as a vanished reference, never as an account
 * carrying movements.
 */
test("refuses a planned payment whose category was deleted under the open form", async ({
  page,
}) => {
  const payments = messages.plannedPayments;
  const errors = messages.errors;
  const concept = `Pago sin categoría ${stamp}`;
  const categoryName = `Categoría efímera ${stamp}`;
  const categoryId = randomUUID();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${categoryName}, 'expense', '#4C8C4A')`;
  });

  await page.goto("/es/planning/payments");
  await addButton(page, payments.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: payments.conceptLabel }).fill(concept);
  await form.getByRole("textbox", { name: payments.amountLabel }).fill("120000");
  await form.getByRole("combobox", { name: payments.fromLabel }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await form.getByLabel(payments.dueLabel).fill("2027-05-09");
  await form.getByRole("combobox", { name: payments.categoryLabel }).click();
  await page.getByRole("option", { name: categoryName, exact: true }).click();

  // Gone between the pick and the save. Nothing references the row yet, so the
  // delete is allowed — which is exactly how a person reaches this state.
  await fixtureSql`delete from categories where id = ${categoryId}`;

  await form.getByRole("button", { name: payments.save, exact: true }).click();

  await expect(page.getByText(errors.referenceGone, { exact: true })).toBeVisible();
  await expect(
    page.getByText(errors.accountHasMovements, { exact: true }),
  ).toHaveCount(0);

  // A refused save keeps the form open and writes nothing.
  await expect(form).toBeVisible();
  expect(
    await fixtureSql`
      select id from planned_payments
      where owner_user_id = ${scope.userId} and description = ${concept}`,
  ).toHaveLength(0);
});

// The same removal against the other screen that reaches it, through a mapper of
// its own: the rule's category is required, so the pick is not even optional.
test("refuses a recurring rule whose category was deleted under the open form", async ({
  page,
}) => {
  const rules = messages.recurringRules;
  const errors = messages.errors;
  const concept = `Regla sin categoría ${stamp}`;
  const categoryName = `Categoría fugaz ${stamp}`;
  const categoryId = randomUUID();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${categoryName}, 'expense', '#4C8C4A')`;
  });

  await page.goto("/es/planning/recurring");
  await addButton(page, rules.add).click();

  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: rules.conceptLabel }).fill(concept);
  await form.getByRole("textbox", { name: rules.amountLabel }).fill("56000");
  await form.getByLabel(rules.nextRunLabel).fill("2027-04-05");
  await form.getByRole("combobox", { name: rules.accountLabel }).click();
  await page.getByRole("option", { name: scope.accountName, exact: true }).click();
  await form.getByRole("combobox", { name: rules.categoryLabel }).click();
  await page.getByRole("option", { name: categoryName, exact: true }).click();

  await fixtureSql`delete from categories where id = ${categoryId}`;

  await form.getByRole("button", { name: rules.save, exact: true }).click();

  await expect(page.getByText(errors.referenceGone, { exact: true })).toBeVisible();
  await expect(
    page.getByText(errors.accountHasMovements, { exact: true }),
  ).toHaveCount(0);

  await expect(form).toBeVisible();
  expect(
    await fixtureSql`
      select id from recurring_rules
      where owner_user_id = ${scope.userId} and description = ${concept}`,
  ).toHaveLength(0);
});

test("revokes a webhook credential and reads the revocation back", async ({
  page,
}) => {
  const webhooks = messages.webhooks;
  const name = `Credencial ${stamp}`;
  const credentialId = randomUUID();

  await asHarnessUser(async (tx) => {
    await tx`
      insert into webhook_credentials (
        id, owner_user_id, name, token_hash, rate_limit_per_min)
      values (
        ${credentialId}, ${scope.userId}, ${name},
        ${createHash("sha256").update(credentialId).digest("hex")}, 37)`;
  });

  await page.goto("/es/settings/webhooks");
  await expect(band(page).getByText(name, { exact: true })).toBeVisible();

  await removeOnlyRow(page, webhooks.revoke, webhooks.revoke);

  // A revoked credential stays listed under its badge: the row is not deleted,
  // it is stamped, and the badge is what says the write landed.
  await expect(
    band(page).getByText(webhooks.revokedBadge, { exact: true }),
  ).toBeVisible();

  const [revoked] = await fixtureSql<{ revoked_at: string | null }[]>`
    select revoked_at::text as revoked_at from webhook_credentials
    where id = ${credentialId}`;
  expect(revoked.revoked_at).not.toBeNull();

  await fixtureSql`delete from webhook_credentials where id = ${credentialId}`;
});

test.describe("the fund's roster", () => {
  const groupId = randomUUID();
  const leaderId = randomUUID();
  const memberId = randomUUID();
  // Sorted after "Harness leader": the roster orders by name, which is what puts
  // this row second and the leader's own first.
  const memberName = `Miembro ${stamp}`;

  // Members live inside a group and the harness user leads none by default, so
  // the group is this suite's own fixture. It goes away either way: a group left
  // behind moves every other screen's scope from personal to group.
  test.beforeEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into groups (id, name, cash_mode)
        values (${groupId}, ${`Fondo ${stamp}`}, 'per_member')`;
      await tx`
        insert into group_members (id, group_id, user_id, name, role)
        values (${leaderId}, ${groupId}, ${scope.userId}, 'Harness leader', 'leader')`;
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

  test("archives a member, restores them and finally deletes them", async ({
    page,
  }) => {
    await page.goto("/es/settings/members");
    await expect(band(page).getByText(memberName, { exact: true })).toBeVisible();

    // Two menus: the leader's own row carries one too, offering only the edit.
    const menus = rowMenus(page);
    await expect(menus).toHaveCount(2);
    await confirmThroughMenu(page, menus.nth(1), common.archive, common.archive);

    await expect(
      band(page).getByText(memberName, { exact: true }),
    ).toHaveCount(0);
    const [archived] = await fixtureSql<{ archived_at: string | null }[]>`
      select archived_at::text as archived_at from group_members
      where id = ${memberId}`;
    expect(archived.archived_at).not.toBeNull();

    // The archived tab holds only this row, so its menu is the only one there.
    await page.goto("/es/settings/members?tab=archived");
    await expect(band(page).getByText(memberName, { exact: true })).toBeVisible();
    await removeOnlyRow(page, common.restore, common.restore);
    await expect(
      band(page).getByText(memberName, { exact: true }),
    ).toHaveCount(0);

    const [restored] = await fixtureSql<{ archived_at: string | null }[]>`
      select archived_at::text as archived_at from group_members
      where id = ${memberId}`;
    expect(restored.archived_at).toBeNull();

    await page.goto("/es/settings/members");
    await confirmThroughMenu(
      page,
      rowMenus(page).nth(1),
      common.delete,
      common.delete,
    );

    await expect(
      band(page).getByText(memberName, { exact: true }),
    ).toHaveCount(0);
    const left = await fixtureSql`
      select id from group_members where id = ${memberId}`;
    expect(left).toHaveLength(0);
  });
});
