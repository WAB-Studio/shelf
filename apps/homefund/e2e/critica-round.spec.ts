/**
 * The deploy critic's findings that needed no decision: the screen that names its
 * period, the phone card that carries its own action, and the bank email that
 * says which way the money moves.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";
import { todayInBogota } from "@/lib/dates";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, seedQueue, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

test("Movimientos names the month its net is over", async ({ page }) => {
  await page.goto("/es/movements");
  await expect(page.getByText(/Neto de [a-záéíóú]+ de \d{4}/).locator("visible=true").first()).toBeVisible();

  await page.goto("/es/movements?from=2026-01-01&to=2026-01-31");
  await expect(page.getByText(/Neto del 1 ene al 31 ene/).locator("visible=true").first()).toBeVisible();
});

test.describe("an overdue payment on the phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  const id = randomUUID();

  test.beforeEach(async () => {
    const [y, m, d] = todayInBogota().split("-").map(Number);
    const due = new Date(Date.UTC(y, m - 1, d - 3)).toISOString().slice(0, 10);
    await asHarnessUser(async (tx) => {
      await tx`
        insert into planned_payments (id, owner_user_id, from_account_id, amount_cents,
          due_date, description, status, created_by)
        values (${id}, ${scope.userId}, ${scope.accountId}, 4200000, ${due},
          ${`Predial ${stamp}`}, 'pending', ${scope.userId})`;
    });
  });

  test.afterEach(async () => {
    await fixtureSql`delete from planned_payments where id = ${id}`;
  });

  test("says Vencido and offers Registrar pago without a menu", async ({ page }) => {
    await page.goto("/es/planning/payments");
    await expect(page.getByText(`Predial ${stamp}`).locator("visible=true")).toBeVisible();
    await expect(page.getByText(messages.plannedPayments.overdueLabel, { exact: false }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: messages.plannedPayments.settle, exact: true }).first(),
    ).toBeVisible();
  });
});

test.describe("a bank email in Bandeja", () => {
  test.afterEach(clearLedger);

  test("reads in pesos and says it is an expense", async ({ page }) => {
    await seedQueue([
      {
        merchant: `Tienda ${stamp}`,
        amountCents: 8_450_000,
        accountId: scope.accountId,
        categoryId: scope.categoryId,
        categorySource: "merchant",
      },
    ]);
    await page.goto("/es/inbox");
    const card = page.getByText("$ 84.500").locator("visible=true").first();
    await expect(card).toBeVisible();
    await expect(page.getByText(messages.ingest.kindExpense, { exact: true }).locator("visible=true").first()).toBeVisible();
    await expect(page.getByText("84.500 COP")).toHaveCount(0);
  });
});
