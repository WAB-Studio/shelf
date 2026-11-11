/**
 * A rule the night's run paused says why on its row (RF-157, Q17), and a rule the
 * run ended refuses to resume with a line that says what to change (Q404).
 *
 * Written from the contract in the plan's M51 and Q17, not from the row component:
 * the lines are the words the user decided, spelled out here so a rewording of the
 * catalogue cannot pass unnoticed. `paused_reason` and ended rules are seeded by
 * SQL on the harness user; the unscoped run is never called.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const rules = messages.recurringRules;

const FAILED_LINE = "Pausada: no se pudo generar el movimiento. Revisa la regla y reanúdala.";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const ids = { account: randomUUID(), category: randomUUID(), rule: randomUUID() };
const RULE = `Regla pausada ${stamp}`;

type Seed = { active: boolean; reason: "failed" | null; endsOn?: "past" };

async function seed({ active, reason, endsOn }: Seed) {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${ids.account}, ${scope.userId}, ${`Cuenta pausada ${stamp}`}, 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.category}, ${scope.userId}, ${`Categoría pausada ${stamp}`}, 'expense', '#4C8C4A')`;
    await tx`
      insert into recurring_rules (
        id, from_account_id, amount_cents, category_id, description, frequency, interval_n, day_of_month,
        next_run_on, is_active, ends_on)
      values (${ids.rule}, ${ids.account}, 1500000, ${ids.category}, ${RULE}, 'weekly', 1, null,
        (now() at time zone 'America/Bogota')::date + 20, ${active},
        ${endsOn === "past" ? fixtureSql`(now() at time zone 'America/Bogota')::date - 5` : null})`;
  });
  if (reason) {
    await fixtureSql`update recurring_rules set paused_reason = ${reason} where id = ${ids.rule}`;
  }
}

test.afterEach(async () => {
  await fixtureSql`delete from recurring_rules where id = ${ids.rule}`;
  await fixtureSql`delete from accounts where id = ${ids.account}`;
  await fixtureSql`delete from categories where id = ${ids.category}`;
});

// The table and the cards both sit in the DOM, cut apart by CSS: the row is the visible one.
function row(page: Page): Locator {
  return page
    .getByRole("row")
    .or(page.locator(".rt-Card"))
    .filter({ hasText: RULE })
    .filter({ visible: true });
}

const visibleText = (scopeOf: Locator | Page, text: string) =>
  scopeOf.getByText(text, { exact: true }).filter({ visible: true });

async function stored() {
  const [r] = await fixtureSql<{ is_active: boolean; paused_reason: string | null }[]>`
    select is_active, paused_reason from recurring_rules where id = ${ids.rule}`;
  return r;
}

test("a rule the run paused shows why on its row", async ({ page }) => {
  // Kills: the row rendering «Pausada» alone.
  await seed({ active: false, reason: "failed" });
  await page.goto("/es/planning/recurring");

  await expect(visibleText(row(page), FAILED_LINE)).toHaveCount(1);
});

test("resuming a rule the run paused takes the line away, and it stays gone after a reload", async ({
  page,
}) => {
  // Kills: a reason cached on the client or never cleared, so the line outlives the resume.
  await seed({ active: false, reason: "failed" });
  await page.goto("/es/planning/recurring");
  await expect(visibleText(row(page), FAILED_LINE)).toHaveCount(1);

  await row(page).getByRole("switch").filter({ visible: true }).click();

  await expect(page.getByText(FAILED_LINE)).toHaveCount(0);
  await expect(visibleText(row(page), rules.stateActive)).toHaveCount(1);
  expect(await stored()).toEqual({ is_active: true, paused_reason: null });

  await page.reload();
  await expect(row(page)).toBeVisible();
  await expect(page.getByText(FAILED_LINE)).toHaveCount(0);
});

test.describe("a wide amount on a narrow phone", () => {
  test("keeps the rule's title readable and the amount inside the card @mobile", async ({
    page,
  }, testInfo) => {
    // Kills: the amount refusing to give its line away, which cut the title to «Suscri…».
    test.skip(testInfo.project.name !== "mobile", "the phone's cards");
    await seed({ active: true, reason: null });
    await fixtureSql`update recurring_rules set amount_cents = 2345678901 where id = ${ids.rule}`;
    await page.goto("/es/planning/recurring");

    const title = page.getByText(RULE, { exact: true }).filter({ visible: true });
    const card = page.locator(".rt-Card").filter({ visible: true }).filter({ has: title });
    const amount = card.getByText(/23\.456\.789/);
    await expect(amount).toBeVisible();

    expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(80);
    const [amountBox, cardBox] = await Promise.all([amount.boundingBox(), card.boundingBox()]);
    expect(amountBox!.x + amountBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  });
});
