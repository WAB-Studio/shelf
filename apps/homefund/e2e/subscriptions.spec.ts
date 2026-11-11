/**
 * «Suscripciones» (RF-185): a charge booked on the same account every month shows as one card with
 * its cadence, its typical amount and its account, and the screen holds a 390 px phone.
 *
 * Written from the contract: four monthly expenses whose descriptions differ only in a reference
 * number must read as one subscription, a one-off expense must not, and a series that stopped
 * months ago sits apart under «sin cobro reciente».
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const copy = messages.subscriptions;

const scope = readScope();
const stamp = randomUUID().slice(0, 8).replace(/[0-9]/g, "x");
const SERIES = `Streaming ${stamp}`;
const ONE_OFF = `Ferreteria ${stamp}`;
const ENDED = `Gimnasio ${stamp}`;
const ids: string[] = [];

test.beforeAll(async () => {
  await asHarnessUser(async (tx) => {
    const rows: [string, number, number][] = [
      [`${SERIES} 4411`, 4, 4_490_000],
      [`${SERIES} 9921`, 3, 4_490_000],
      [`${SERIES} 1200`, 2, 4_490_000],
      [`${SERIES} 7731`, 1, 4_490_000],
      [ONE_OFF, 2, 12_000_000],
      [`${ENDED} 1`, 8, 9_000_000],
      [`${ENDED} 2`, 7, 9_000_000],
      [`${ENDED} 3`, 6, 9_000_000],
    ];
    for (const [description, monthsBack, cents] of rows) {
      const id = randomUUID();
      ids.push(id);
      await tx`
        insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
        values (${id}, ${scope.accountId}, ${cents},
          ((now() at time zone 'America/Bogota')::date - make_interval(months => ${monthsBack}))::date, ${description})`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${id}, ${scope.categoryId}, ${cents})`;
    }
  });
});

test.afterAll(async () => {
  await fixtureSql`delete from transaction_splits where transaction_id in ${fixtureSql(ids)}`;
  await fixtureSql`delete from transactions where id in ${fixtureSql(ids)}`;
});

function card(page: Page, text: string) {
  return page.locator(".rt-Card").filter({ hasText: text }).filter({ visible: true });
}

test("a monthly charge reads as one subscription with its cadence, and a one-off charge does not", async ({
  page,
}) => {
  await page.goto("/es/planning/subscriptions");

  await expect(page.getByRole("heading", { name: copy.title, level: 1 })).toBeVisible();
  const series = card(page, SERIES);
  await expect(series).toHaveCount(1);
  await expect(series).toContainText(copy.monthly);
  await expect(series).toContainText("44.900");
  await expect(card(page, ONE_OFF)).toHaveCount(0);
  await expect(page.getByText(/\$\s?[\d.]+ al mes/).filter({ visible: true }).first()).toBeVisible();
});

test("a series that stopped months ago sits under its own label with its last date", async ({ page }) => {
  await page.goto("/es/planning/subscriptions");

  const ended = card(page, ENDED);
  await expect(ended).toHaveCount(1);
  await expect(ended).toContainText("Último cobro");
  await expect(page.getByText(/sin cobro reciente$/).filter({ visible: true })).toBeVisible();
  await expect(card(page, SERIES)).not.toContainText("Último cobro");
});

test("holds a 390 px phone without sideways scroll @mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/es/planning/subscriptions");
  await expect(card(page, SERIES)).toHaveCount(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
