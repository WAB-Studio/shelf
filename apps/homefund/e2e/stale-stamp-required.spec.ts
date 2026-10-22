/**
 * RF-156: an edit sent without the stamp its form loaded is refused as stale, on the four
 * update actions (account, planned payment, recurring rule, movement). Leaving the field out
 * of a request must not step around the guard.
 *
 * Written from the contract, not from the actions. The body shape and the action id are
 * learned from each form's own save caught on the wire; the forged call replays that body
 * with `expectedUpdatedAt` removed and one visible field changed, so a write that slipped
 * through would show. The owed outcome is read from Postgres: the row's `updated_at` and
 * field, and the audit trail (a refusal writes nothing, so it leaves no row).
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const { accounts, plannedPayments: payments, recurringRules: rules, transactions, common } = messages;

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "a forged call does not depend on the viewport");
});

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const ids = {
  account: randomUUID(),
  category: randomUUID(),
  payment: randomUUID(),
  rule: randomUUID(),
  movement: randomUUID(),
};
const NAMES = {
  account: `Cuenta sello ${stamp}`,
  payment: `Pago sello ${stamp}`,
  rule: `Regla sello ${stamp}`,
  movement: `Movimiento sello ${stamp}`,
};

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.account}, ${scope.userId}, ${NAMES.account}, 'asset', 'bank', 500000, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.category}, ${scope.userId}, ${`Categoría sello ${stamp}`}, 'expense', '#4C8C4A')`;
    await tx`
      insert into planned_payments (id, from_account_id, amount_cents, due_date, description)
      values (${ids.payment}, ${ids.account}, 2000000, '2027-03-12', ${NAMES.payment})`;
    await tx`
      insert into recurring_rules (
        id, from_account_id, amount_cents, category_id, description, frequency, interval_n, day_of_month, next_run_on)
      values (${ids.rule}, ${ids.account}, 1500000, ${ids.category}, ${NAMES.rule}, 'weekly', 1, null,
        (now() at time zone ${TIME_ZONE})::date + 3)`;
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${ids.movement}, ${ids.account}, 1500000, (now() at time zone ${TIME_ZONE})::date, ${NAMES.movement})`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${ids.movement}, ${ids.category}, 1500000)`;
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from transactions where id = ${ids.movement}`;
  await fixtureSql`delete from recurring_rules where id = ${ids.rule}`;
  await fixtureSql`delete from planned_payments where id = ${ids.payment}`;
  await fixtureSql`delete from accounts where id = ${ids.account}`;
  await fixtureSql`delete from categories where id = ${ids.category}`;
});

type Learned = { id: string; url: string; args: Record<string, unknown>[] };

// The form's own save, caught on the wire: the action it calls and the body it sends.
async function catchSave(page: Page, rowId: string, save: () => Promise<void>): Promise<Learned> {
  const seen: Learned[] = [];
  page.on("request", (request) => {
    const id = request.headers()["next-action"];
    const body = request.postData();
    if (request.method() === "POST" && id && body?.includes(rowId)) {
      seen.push({ id, url: request.url(), args: JSON.parse(body) });
    }
  });
  await save();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  return seen[0];
}

// A success answers `{}`; a refusal carries `serverError`.
// Replays the learned body with the stamp left out and one field changed.
async function forge(page: Page, learned: Learned, change: Record<string, unknown>): Promise<string> {
  expect(learned.args[0], "the form's own body carries the stamp").toHaveProperty("expectedUpdatedAt");
  const rest = { ...learned.args[0] };
  delete rest.expectedUpdatedAt;
  const answer = await page.request.post(learned.url, {
    headers: {
      "next-action": learned.id,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
    },
    data: JSON.stringify([{ ...rest, ...change }]),
  });
  const flight = await answer.text();
  const line = flight.split("\n").find((candidate) => /^\w+:\{("data"|"serverError"|"validationErrors"|\})/.test(candidate));
  expect(line, "the answer carries no action result").toBeDefined();
  return line ?? "";
}

async function row(table: "accounts" | "planned_payments" | "recurring_rules" | "transactions", id: string) {
  const [found] = await fixtureSql<{ label: string; updated_at: string }[]>`
    select ${table === "accounts" ? fixtureSql`name` : fixtureSql`description`} as label, updated_at::text as updated_at
    from ${fixtureSql(table)} where id = ${id}`;
  return found;
}

async function trail(id: string): Promise<number> {
  const [{ count }] = await fixtureSql<{ count: string }[]>`
    select count(*)::text as count from audit_log where record_id = ${id}`;
  return Number(count);
}

const actionsOf = (page: Page, name: string) =>
  page.getByRole("button", { name: common.actionsFor.replace("{name}", name), exact: true }).filter({ visible: true });

async function editAccount(page: Page, renamed: string) {
  await page.goto("/es/settings/accounts");
  await actionsOf(page, NAMES.account).click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: accounts.nameLabel }).fill(renamed);
  await dialog.getByRole("button", { name: common.save, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function editPayment(page: Page, renamed: string) {
  await page.goto("/es/planning/payments");
  await actionsOf(page, NAMES.payment).click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: payments.conceptLabel }).fill(renamed);
  await dialog.getByRole("button", { name: payments.save, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function editRule(page: Page, renamed: string) {
  await page.goto("/es/planning/recurring");
  await actionsOf(page, NAMES.rule).click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: rules.conceptLabel }).fill(renamed);
  await dialog.getByRole("button", { name: rules.save, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function editMovement(page: Page, renamed: string) {
  await page.goto(`/es/movements/${ids.movement}`);
  await page.getByRole("button", { name: transactions.edit, exact: true }).click();
  const dialog: Locator = page.getByRole("dialog");
  await dialog.locator("#movement-note").fill(renamed);
  await dialog.getByRole("button", { name: transactions.saveMovement, exact: true }).click();
  await expect(dialog).toBeHidden();
}

const cases = [
  { label: "account", table: "accounts", id: () => ids.account, key: "name", edit: editAccount, path: "/es/settings/accounts" },
  { label: "planned payment", table: "planned_payments", id: () => ids.payment, key: "description", edit: editPayment, path: "/es/planning/payments" },
  { label: "recurring rule", table: "recurring_rules", id: () => ids.rule, key: "description", edit: editRule, path: "/es/planning/recurring" },
  { label: "movement", table: "transactions", id: () => ids.movement, key: "description", edit: editMovement, path: "/es/movements" },
] as const;

for (const one of cases) {
  test(`${one.label}: a forged update without the stamp is refused in the stale words`, async ({ page }) => {
    // Kills: the stamp optional and the guard skipped when it is absent.
    const learned = await catchSave(page, one.id(), () => one.edit(page, `${one.label} editada ${stamp}`));

    const text = await forge(page, learned, { [one.key]: `${one.label} FORJADA ${stamp}` });

    expect(text).toContain("errors.stale");
    expect(text).not.toContain("errors.unexpected");
  });

  test(`${one.label}: a forged update without the stamp changes nothing and leaves no audit row`, async ({ page }) => {
    // Kills: a refusal that still writes, or a guard placed after the write (its audit row stays behind).
    const learned = await catchSave(page, one.id(), () => one.edit(page, `${one.label} editada ${stamp}`));
    const afterForm = await row(one.table, one.id());
    const trailBefore = await trail(one.id());

    await forge(page, learned, { [one.key]: `${one.label} FORJADA ${stamp}` });

    expect(await row(one.table, one.id())).toEqual(afterForm);
    expect(afterForm.label).not.toContain("FORJADA");
    expect(await trail(one.id())).toBe(trailBefore);
  });

  test(`${one.label}: the form's own edit, with its stamp, still saves and the list shows it`, async ({ page }) => {
    // Kills: a guard that refuses a present stamp, so every ordinary edit fails.
    const renamed = `${one.label} vigente ${stamp}`;
    await one.edit(page, renamed);

    expect((await row(one.table, one.id())).label).toBe(renamed);
    await page.goto(one.path);
    await expect(page.getByText(renamed, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });
}
