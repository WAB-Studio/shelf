/**
 * RF-133: a movement read with only one side known waits in «Bandeja» under «Por completar», and naming
 * the other account there completes it (and teaches its pattern, RF-135). Copy comes from the file the
 * screen reads.
 */
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const awaiting = messages.ingest.awaiting;
const scope = readScope();
const DESCRIPTION = "TRANSF A BOLSILLO 4410";

test.describe("Por completar", () => {
  const pocket = { id: randomUUID(), name: `Harness bolsillo ${randomUUID().slice(0, 6)}` };
  let movementId = "";

  test.beforeEach(async () => {
    await clearLedger();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${pocket.id}, ${scope.userId}, ${pocket.name}, 'asset', 'bank', 0, '2026-01-01')
        on conflict (id) do nothing`;
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description, awaiting_counterparty)
        values (${scope.accountId}, 2500000, '2026-09-20', ${DESCRIPTION}, true)
        returning id`;
      movementId = movement.id;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, 2500000)`;
    });
  });

  test.afterEach(async () => {
    await clearLedger();
    await asHarnessUser(async (tx) => {
      await tx`delete from ingest_counterparties where owner_user_id = ${scope.userId}`;
      await tx`delete from accounts where id = ${pocket.id}`;
    });
  });

  test("names the missing account and completes the movement", async ({ page }) => {
    await page.goto("/es/inbox");
    await expect(page.getByRole("heading", { name: awaiting.title.replace("{count}", "1") })).toBeVisible();
    await expect(page.getByText(DESCRIPTION)).toBeVisible();

    const complete = page.getByRole("button", { name: awaiting.complete, exact: true });
    await expect(complete).toBeDisabled();
    await page.getByRole("combobox", { name: awaiting.toLabel }).click();
    await page.getByRole("option", { name: pocket.name }).click();
    await complete.click();

    await expect(page.getByText(awaiting.completed)).toBeVisible();
    await expect(page.getByText(DESCRIPTION)).toHaveCount(0);
    const [row] = await fixtureSql<{ to_account_id: string | null; awaiting_counterparty: boolean; splits: number }[]>`
      select t.to_account_id, t.awaiting_counterparty,
        (select count(*)::int from transaction_splits s where s.transaction_id = t.id) as splits
      from transactions t where t.id = ${movementId}`;
    expect(row).toEqual({ to_account_id: pocket.id, awaiting_counterparty: false, splits: 0 });
  });
});
