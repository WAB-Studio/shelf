/**
 * The recurring rule's edit dialog against a version that moved (Q24, RNF-10): the
 * daily run advances a rule's `next_run_on` while a person has it open, and the
 * save that follows is told to reopen it, with what was typed still on screen and
 * the rule's stored figures unchanged.
 *
 * Written from the contract in `docs/SPEC.md` §1 (Q24) and the plan's M47/M48, not
 * from the dialog: the refusal line is the catalogue's `errors.stale`, shown in the
 * dialog, never a toast that vanishes with the form still open.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const rules = messages.recurringRules;
const common = messages.common;

test.use({ viewport: { width: 1280, height: 900 } });

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const ids = { account: randomUUID(), category: randomUUID(), rule: randomUUID() };
const RULE = `Regla vencida ${stamp}`;

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.account}, ${scope.userId}, ${`Cuenta de regla ${stamp}`}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.category}, ${scope.userId}, ${`Categoría de regla ${stamp}`}, 'expense', '#4C8C4A')`;
    await tx`
      insert into recurring_rules (
        id, from_account_id, amount_cents, category_id, description, frequency, interval_n, day_of_month, next_run_on)
      values (${ids.rule}, ${ids.account}, 1500000, ${ids.category}, ${RULE}, 'weekly', 1, null,
        (now() at time zone 'America/Bogota')::date + 3)`;
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from recurring_rules where id = ${ids.rule}`;
  await fixtureSql`delete from accounts where id = ${ids.account}`;
  await fixtureSql`delete from categories where id = ${ids.category}`;
});

async function openEdit(page: Page): Promise<Locator> {
  await page.goto("/es/planning/recurring");
  await page
    .getByRole("button", { name: common.actionsFor.replace("{name}", RULE), exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: rules.conceptLabel })).toHaveValue(RULE);
  return dialog;
}

const save = (dialog: Locator) => dialog.getByRole("button", { name: rules.save, exact: true });

async function stored() {
  const [row] = await fixtureSql<{ amount_cents: string; next_run_on: string }[]>`
    select amount_cents::text as amount_cents, next_run_on::text as next_run_on
    from recurring_rules where id = ${ids.rule}`;
  return row;
}

test("a save after the run moved the rule is refused as stale, keeping what was typed and changing nothing", async ({
  page,
}) => {
  // Kills: no expected version sent, or the stale answer ignored, so the save lands over the run's advance.
  const dialog = await openEdit(page);
  await dialog.getByRole("textbox", { name: rules.amountLabel }).fill("27000");

  // What the daily run does to a due rule: the cursor moves forward and the row is stamped anew.
  await fixtureSql`
    update recurring_rules set next_run_on = next_run_on + 7 where id = ${ids.rule}`;
  const afterRun = await stored();

  await save(dialog).click();

  await expect(dialog.getByText(messages.errors.stale, { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: rules.amountLabel })).toHaveValue(/^27\D?000$/);
  await expect(save(dialog)).toBeEnabled();
  expect(await stored()).toEqual(afterRun);
  expect(afterRun.amount_cents).toBe("1500000");
});

test("a rule nobody touched saves, even after the dialog sat open", async ({ page }) => {
  // Kills: an expected version that never matches, so every ordinary edit is refused.
  const dialog = await openEdit(page);
  await dialog.getByRole("textbox", { name: rules.amountLabel }).fill("27000");
  await save(dialog).click();

  await expect(dialog).toBeHidden();
  expect((await stored()).amount_cents).toBe("2700000");
});
