/**
 * The debt this slice pays: `/inbox` shipped with done criteria that named a
 * browser and an authenticated session, and was merged without either. Every
 * assertion here is one of those criteria (plan modules 10, 11 and 17).
 *
 * The copy is read from the message file the screen reads, so a rewording moves
 * both at once and never leaves a spec asserting a string nobody renders.
 */
import { createHash, randomUUID } from "node:crypto";

import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, seedQueue, test } from "./global-setup";

const ingest = messages.ingest;
const transactions = messages.transactions;
const common = messages.common;

const scope = readScope();

// 45.000 pesos, as the card reads it and as the prefilled form carries it.
const AMOUNT_CENTS = 4500000;
// The form groups thousands as they are written into the field.
const AMOUNT_PESOS = "45.000";

const TRUSTED = "Exito Poblado";
const UNREADABLE = "Comercio sin datos";
const DEFAULTED = "Comercio por defecto";

// A complete proposal: a trusted merchant taught the category, and the amount and
// account both read. One tap records it.
const complete = {
  merchant: TRUSTED,
  amountCents: AMOUNT_CENTS,
  accountId: scope.accountId,
  categoryId: scope.categoryId,
  categorySource: "merchant" as const,
  trusted: true,
};

// Everything the interpreter failed to read, so the card names each gap.
const incomplete = {
  merchant: UNREADABLE,
  amountCents: null,
  accountId: null,
  categoryId: null,
  categorySource: null,
};

// Read in full, but the category came from the credential's fallback rather than
// from anything about this message — which is exactly why it is not one tap.
const defaulted = {
  merchant: DEFAULTED,
  amountCents: AMOUNT_CENTS,
  accountId: scope.accountId,
  categoryId: scope.categoryId,
  categorySource: "credential_default" as const,
};

// «Marcar las N que están listas para anotarlas juntas», the plural the message file spells.
function readyLabel(count: number): string {
  return `Marcar las ${count} que están listas para anotarlas juntas`;
}

function acceptButton(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: ingest.accept, exact: true });
}

function reviewButton(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: ingest.review, exact: true });
}

/**
 * The band the width displays. Both the phone's cards and the laptop's table
 * mount at every width, cut apart by CSS alone, so a locator that names no band
 * reaches a delivery twice and dies on strict mode — `getByRole` alone would not:
 * only `getByText` and friends look past `display: none`.
 */
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The table's row menu names the row it belongs to, so one delivery among many
// is reached by its own name and never by a position in the queue.
function rowActions(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

test.describe("the inbox queue", () => {
  // The dense table renders from `lg` up and the card list below it; both
  // projects drive both bands at the width the artboard states rather than
  // skipping one of them (RNF-08), following `debts.spec.ts`'s own precedent.
  test.describe("the laptop band", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("shows one row per delivery, the incomplete one naming each gap in amber", async ({
      page,
    }) => {
      await seedQueue([complete, incomplete]);
      await page.goto("/es/inbox");

      const table = page.getByRole("table", { name: ingest.title });
      await expect(table).toBeVisible();

      const trustedRow = table.getByRole("row").filter({ hasText: TRUSTED });
      const unreadableRow = table
        .getByRole("row")
        .filter({ hasText: UNREADABLE });
      await expect(trustedRow).toHaveCount(1);
      await expect(unreadableRow).toHaveCount(1);

      // Each gap is named, and named in amber: that colour is what tells the
      // two rows apart at a glance.
      for (const missing of [
        ingest.amountMissing,
        ingest.accountMissing,
        ingest.categoryMissing,
      ]) {
        const field = unreadableRow.getByText(missing, { exact: true });
        await expect(field).toBeVisible();
        await expect(field).toHaveAttribute("data-accent-color", "amber");
      }
    });

    test("says which key a delivery came through, in the row and in the card (RF-203)", async ({
      page,
    }) => {
      const [deliveryId] = await seedQueue([complete]);
      await asHarnessUser(async (tx) => {
        const [key] = await tx<{ id: string }[]>`
          insert into webhook_credentials (name, token_hash, kind)
          values ('Mi celular e2e', ${"e".repeat(64)}, 'android')
          returning id`;
        await tx`update ingest_deliveries set credential_id = ${key.id} where id = ${deliveryId}`;
      });
      // A phone's key says where the message came from, never the key's own name (RF-203, RF-278).
      const via = "Llegó por notificación del celular";

      await page.goto("/es/inbox");
      await expect(
        page.getByRole("table", { name: ingest.title }).getByText(via),
      ).toBeVisible();

      await page.setViewportSize({ width: 390, height: 800 });
      await expect(page.getByText(via).locator("visible=true")).toHaveCount(1);
    });

    test("shows a refused message in full, so a confirmation code is readable (RF-204)", async ({
      page,
    }) => {
      await seedQueue([]);
      const code = "483920";
      const text = `Confirmación de reenvío de Gmail: ${"texto largo ".repeat(12)}Código de confirmación: ${code}`;
      await asHarnessUser(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into ingest_deliveries (external_ref, raw_text, shape_hash)
          values (${`refused-${code}`}, ${text}, ${"f".repeat(64)})
          returning id`;
        await tx`
          update ingest_deliveries
          set status = 'rejected', reject_reason = 'no_movement_signal', resolved_at = now()
          where id = ${row.id}`;
      });

      await page.goto("/es/inbox");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByText(`Código de confirmación: ${code}`)).toBeVisible();
    });

    test("records the movement from the row menu and drops the row, but only opens the form for an incomplete one", async ({
      page,
    }) => {
      await clearLedger();
      const [deliveryId, incompleteId] = await seedQueue([complete, incomplete]);
      await page.goto("/es/inbox");

      const table = page.getByRole("table", { name: ingest.title });
      const trustedRow = table.getByRole("row").filter({ hasText: TRUSTED });

      await rowActions(page, TRUSTED).click();
      await page
        .getByRole("menuitem", { name: ingest.accept, exact: true })
        .click();
      // The closing menu can leave the row unreachable from the ax tree for a
      // tick of its own, so the toast — raised only once the write settles — is
      // what "accepted" actually waits on, not the row's own disappearance.
      await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
      await expect(trustedRow).toHaveCount(0);

      const movements = await fixtureSql<
        { id: string; amount_cents: string; from_account_id: string }[]
      >`
        select id, amount_cents::text as amount_cents, from_account_id
        from transactions
        where owner_user_id = ${scope.userId}`;
      expect(movements).toHaveLength(1);
      expect(movements[0].amount_cents).toBe(String(AMOUNT_CENTS));
      expect(movements[0].from_account_id).toBe(scope.accountId);

      const [delivery] = await fixtureSql<
        { status: string; transaction_id: string | null }[]
      >`select status, transaction_id from ingest_deliveries where id = ${deliveryId}`;
      expect(delivery.status).toBe("accepted");
      expect(delivery.transaction_id).toBe(movements[0].id);

      // RF-91: an incomplete proposal's own "accept" item never writes on its
      // own — it opens the same prefilled form the row's "openForm" does. The
      // dialog is modal and marks the row behind it `aria-hidden`, so the
      // ledger is what proves nothing was recorded, not the row's own
      // reachability while the form sits over it.
      await rowActions(page, UNREADABLE).click();
      await page
        .getByRole("menuitem", { name: ingest.accept, exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();

      const [stillPending] = await fixtureSql<{ status: string }[]>`
        select status from ingest_deliveries where id = ${incompleteId}`;
      expect(stillPending.status).toBe("pending");
    });
  });

  test.describe("the phone list", () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test("shows one card per delivery, one to accept and one to review @mobile", async ({
      page,
    }) => {
      await seedQueue([complete, incomplete]);
      await page.goto("/es/inbox");

      await expect(page.getByRole("heading", { name: TRUSTED })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: UNREADABLE }),
      ).toBeVisible();

      await expect(acceptButton(page)).toHaveCount(1);
      await expect(reviewButton(page)).toHaveCount(1);

      // Each gap is named, and named in amber: that colour is what tells the two
      // cards apart at a glance. Scoped to the visible band: the laptop table
      // names the same gaps in the same words.
      for (const missing of [
        ingest.amountMissing,
        ingest.accountMissing,
        ingest.categoryMissing,
      ]) {
        const field = band(page).getByText(missing, { exact: true });
        await expect(field).toBeVisible();
        await expect(field).toHaveAttribute("data-accent-color", "amber");
      }
    });

    test("records the movement on accept and drops the card @mobile", async ({
      page,
    }) => {
      await clearLedger();
      const [deliveryId] = await seedQueue([complete]);
      await page.goto("/es/inbox");

      await acceptButton(page).click();
      await expect(page.getByRole("heading", { name: TRUSTED })).toHaveCount(
        0,
      );

      const movements = await fixtureSql<
        { id: string; amount_cents: string; from_account_id: string }[]
      >`
        select id, amount_cents::text as amount_cents, from_account_id
        from transactions
        where owner_user_id = ${scope.userId}`;
      expect(movements).toHaveLength(1);
      expect(movements[0].amount_cents).toBe(String(AMOUNT_CENTS));
      expect(movements[0].from_account_id).toBe(scope.accountId);

      const [delivery] = await fixtureSql<
        { status: string; transaction_id: string | null }[]
      >`select status, transaction_id from ingest_deliveries where id = ${deliveryId}`;
      expect(delivery.status).toBe("accepted");
      expect(delivery.transaction_id).toBe(movements[0].id);
    });
  });
});

// The card does its own work: the date the message prints, a category chosen in place, «Descartar» in sight, several
// recorded in one write, and a delivery a movement already covers discarded in one tap (RF-257).
test.describe("the card without the form", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  const second = { ...complete, merchant: "Exito Laureles" };

  async function movementsOf(): Promise<{ id: string; category_id: string }[]> {
    return fixtureSql<{ id: string; category_id: string }[]>`
      select t.id, s.category_id from transactions t
      join transaction_splits s on s.transaction_id = t.id
      where t.owner_user_id = ${scope.userId}`;
  }

  test("shows the day the message prints, not the hour it arrived @mobile", async ({ page }) => {
    await clearLedger();
    const [deliveryId] = await seedQueue([complete]);
    await asHarnessUser(async (tx) => {
      await tx`update ingest_deliveries set proposed_occurred_at = '2026-11-10' where id = ${deliveryId}`;
    });
    await page.goto("/es/inbox");

    await expect(band(page).getByText(/Fecha: 10 nov/)).toBeVisible();
    await expect(band(page).getByText(/Llegó el/)).toHaveCount(0);
  });

  test("records with a category chosen on the card, without opening the form @mobile", async ({ page }) => {
    await clearLedger();
    const [deliveryId] = await seedQueue([{ ...complete, merchant: "Comercio sin categoria", categoryId: null, categorySource: null, trusted: false }]);
    await page.goto("/es/inbox");

    await expect(reviewButton(page)).toHaveCount(1);
    await page.getByRole("combobox", { name: ingest.categoryLabel }).click();
    await page.getByRole("option", { name: scope.categoryName, exact: true }).click();

    await expect(acceptButton(page)).toHaveCount(1);
    await acceptButton(page).click();
    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();

    const movements = await movementsOf();
    expect(movements).toHaveLength(1);
    expect(movements[0].category_id).toBe(scope.categoryId);
    const [delivery] = await fixtureSql<{ status: string }[]>`select status from ingest_deliveries where id = ${deliveryId}`;
    expect(delivery.status).toBe("accepted");
  });

  test("has «Descartar» on the card itself and asks before sending the message away @mobile", async ({ page }) => {
    await clearLedger();
    const [deliveryId] = await seedQueue([complete]);
    await page.goto("/es/inbox");

    await page.getByRole("button", { name: ingest.reject, exact: true }).click();
    await page.getByRole("button", { name: ingest.rejectOnce, exact: true }).click();
    await expect(page.getByText(ingest.rejectedToast)).toBeVisible();

    const [delivery] = await fixtureSql<{ status: string }[]>`select status from ingest_deliveries where id = ${deliveryId}`;
    expect(delivery.status).toBe("rejected");
    expect(await movementsOf()).toHaveLength(0);
  });

  test("records the chosen ready cards in one write, and only the ready ones can be chosen @mobile", async ({ page }) => {
    await clearLedger();
    await seedQueue([complete, second, incomplete]);
    await page.goto("/es/inbox");

    await expect(page.getByRole("checkbox")).toHaveCount(2);
    await page.getByRole("button", { name: readyLabel(2), exact: true }).click();
    await expect(band(page).getByText("2 elegidas")).toBeVisible();
    await page.getByRole("button", { name: ingest.acceptSelected.replace("{count}", "2"), exact: true }).click();

    await expect(page.getByText("2 movimientos anotados.")).toBeVisible();
    expect(await movementsOf()).toHaveLength(2);
    await expect(page.getByRole("heading", { name: UNREADABLE })).toBeVisible();
  });

  test("records none of the batch when one is refused @mobile", async ({ page }) => {
    await clearLedger();
    const [first, , third] = await seedQueue([complete, second, { ...complete, merchant: "Exito Envigado" }]);
    await page.goto("/es/inbox");

    await page.getByRole("button", { name: readyLabel(3), exact: true }).click();
    // A delivery decided elsewhere while the page was open: its accept is refused, and the whole batch with it.
    await fixtureSql`update ingest_deliveries set status = 'rejected', resolved_at = now() where id = ${third}`;
    await page.getByRole("button", { name: ingest.acceptSelected.replace("{count}", "3"), exact: true }).click();

    await expect(page.getByText(ingest.batchRefused)).toBeVisible();
    expect(await movementsOf()).toHaveLength(0);
    const [delivery] = await fixtureSql<{ status: string }[]>`select status from ingest_deliveries where id = ${first}`;
    expect(delivery.status).toBe("pending");
  });

  test("marks a delivery a hand-made movement covers «Ya registrado» and discards it as a repeat in one tap @mobile", async ({ page }) => {
    await clearLedger();
    const [deliveryId] = await seedQueue([complete]);
    await asHarnessUser(async (tx) => {
      const [movement] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${scope.accountId}, ${AMOUNT_CENTS}, (now() at time zone 'America/Bogota')::date, 'Tienda de la vecina')
        returning id`;
      await tx`insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movement.id}, ${scope.categoryId}, ${AMOUNT_CENTS})`;
    });
    await page.goto("/es/inbox");

    await expect(band(page).getByText(ingest.alreadyRecorded, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: ingest.rejectDuplicate, exact: true }).click();
    await expect(page.getByText(ingest.duplicateRejectedToast)).toBeVisible();

    const [delivery] = await fixtureSql<{ status: string; reason: string | null }[]>`
      select status, reject_reason as reason from ingest_deliveries where id = ${deliveryId}`;
    expect(delivery).toEqual({ status: "rejected", reason: "duplicate" });
    expect(await movementsOf()).toHaveLength(1);
  });
});

test.describe("a category that came from a credential default", () => {
  test.beforeEach(async () => {
    // Cleared before seeding: a laptop-band case below writes a movement and
    // reads the ledger back, and this queue's own delivery must be the only
    // thing seeded after that reset.
    await clearLedger();
    await seedQueue([defaulted]);
  });

  test.describe("the laptop band", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("opens the form already carrying the read amount, account and category", async ({
      page,
    }) => {
      await page.goto("/es/inbox");

      await rowActions(page, DEFAULTED).click();
      await page
        .getByRole("menuitem", { name: ingest.accept, exact: true })
        .click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const amounts = dialog.getByRole("textbox", {
        name: transactions.amountLabel,
      });
      await expect(amounts).toHaveCount(1);
      await expect(amounts.nth(0)).toHaveValue(AMOUNT_PESOS);

      await expect(
        dialog.getByRole("combobox", { name: transactions.accountLabel, exact: true }),
      ).toHaveText(scope.accountName);
      await expect(
        dialog.getByRole("button", { name: scope.categoryName, exact: true, pressed: true }),
      ).toBeVisible();
    });
  });

  test.describe("the phone list", () => {
    test.use({ viewport: { width: 360, height: 740 } });

    test("opens the form already carrying the read amount, account and category", async ({
      page,
    }) => {
      await page.goto("/es/inbox");
      await reviewButton(page).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // One field carries the amount: the lone split mirrors it behind «Dividir» (RF-69).
      const amounts = dialog.getByRole("textbox", {
        name: transactions.amountLabel,
      });
      await expect(amounts).toHaveCount(1);
      await expect(amounts.nth(0)).toHaveValue(AMOUNT_PESOS);

      await expect(
        dialog.getByRole("combobox", { name: transactions.accountLabel, exact: true }),
      ).toHaveText(scope.accountName);
      await expect(
        dialog.getByRole("button", { name: scope.categoryName, exact: true, pressed: true }),
      ).toBeVisible();
    });
  });
});

test.describe("the queue at 360 px", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 360,
    "RNF-08's base case is the mobile project's viewport",
  );

  test("holds with no horizontal overflow and no control under 32 px @mobile", async ({
    page,
  }) => {
    await seedQueue([complete, incomplete]);
    await page.goto("/es/inbox");
    await expect(page.getByRole("heading", { name: TRUSTED })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const controls = page.getByRole("button").or(page.getByRole("link"));
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible())) continue;

      const box = await control.boundingBox();
      expect(box, `control ${index} has no box`).not.toBeNull();
      expect(
        Math.min(box!.width, box!.height),
        `control ${index} named ${JSON.stringify(await control.textContent())}`,
      ).toBeGreaterThanOrEqual(32);
    }
  });
});

// What the card proposes and lets the person change, read from the messages a bank sends (RF-278, RF-279, RF-280).
// Every message here is synthetic: invented names, figures and numbers.
test.describe("the card's proposal, at 390 px", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  const DAY = "10/11/2026";
  const created: { accounts: string[]; categories: string[] } = { accounts: [], categories: [] };

  async function addAccount(name: string, subtype: "bank" | "cash"): Promise<string> {
    const id = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${name}, 'asset', ${subtype}, 0, '2025-01-01')`;
    });
    created.accounts.push(id);
    return id;
  }

  async function addCategory(name: string, kind: "income" | "expense"): Promise<string> {
    const id = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${id}, ${scope.userId}, ${name}, ${kind}, '#4C8C4A')`;
    });
    created.categories.push(id);
    return id;
  }

  // A message through the real ingest door, under a key whose defaults are an expense category: the worst case for
  // an income, which used to take it.
  async function receive(request: APIRequestContext, text: string): Promise<string> {
    const token = `e2e-${randomUUID()}`;
    await asHarnessUser(async (tx) => {
      await tx`
        insert into webhook_credentials (name, token_hash, kind, default_account_id, default_category_id)
        values ('Llave e2e', ${createHash("sha256").update(token).digest("hex")}, 'android',
          ${scope.accountId}, ${scope.categoryId})`;
    });
    const response = await request.post("/api/webhooks/ingest", {
      headers: { authorization: `Bearer ${token}` },
      data: { text },
    });
    expect(response.status()).toBe(200);
    const [delivery] = await fixtureSql<{ id: string }[]>`
      select id from ingest_deliveries where owner_user_id = ${scope.userId} and raw_text = ${text}`;
    return delivery.id;
  }

  test.beforeEach(async () => {
    await clearLedger();
    await seedQueue([]);
  });

  test.afterEach(async () => {
    await clearLedger();
    await asHarnessUser(async (tx) => {
      await tx`delete from webhook_credentials where name = 'Llave e2e'`;
      for (const id of created.categories) await tx`delete from categories where id = ${id}`;
      for (const id of created.accounts) await tx`delete from accounts where id = ${id}`;
    });
    created.accounts.length = 0;
    created.categories.length = 0;
  });

  test("an income is never proposed an expense category, and is recorded once an income one is chosen @mobile", async ({ page, request }) => {
    const incomeName = "Ingreso e2e";
    await addCategory(incomeName, "income");
    const text = `Bancolombia: Recibiste una transferencia por $450.000 de CARLOS PEREZ en tu cuenta de Ahorros el ${DAY} a las 19:05.`;
    const deliveryId = await receive(request, text);

    const [proposal] = await fixtureSql<{ category: string | null; direction: string }[]>`
      select proposed_category_id as category, proposed_direction as direction from ingest_deliveries where id = ${deliveryId}`;
    expect(proposal).toEqual({ category: null, direction: "income" });

    await page.goto("/es/inbox");
    await expect(band(page).getByText(ingest.categoryMissing, { exact: true })).toBeVisible();
    await expect(acceptButton(page)).toHaveCount(0);
    await expect(reviewButton(page)).toHaveCount(1);

    await page.getByRole("combobox", { name: ingest.categoryLabel }).click();
    await expect(page.getByRole("option", { name: scope.categoryName, exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: incomeName, exact: true }).click();
    await acceptButton(page).click();

    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
    await expect(page.getByText(messages.errors.unexpected)).toHaveCount(0);
    const [movement] = await fixtureSql<{ from: string | null; to: string | null; amount: string }[]>`
      select from_account_id as from, to_account_id as to, amount_cents::text as amount
      from transactions where owner_user_id = ${scope.userId}`;
    expect(movement).toEqual({ from: null, to: scope.accountId, amount: "45000000" });
  });

  test("a stored income card that carries an expense category reads as incomplete @mobile", async ({ page }) => {
    await seedQueue([{ ...complete, direction: "income", categorySource: "credential_default", trusted: false }]);
    await page.goto("/es/inbox");

    await expect(band(page).getByText(ingest.categoryMissing, { exact: true })).toBeVisible();
    await expect(acceptButton(page)).toHaveCount(0);
    await expect(reviewButton(page)).toHaveCount(1);
  });

  test("a cash machine withdrawal is proposed as «Retirar efectivo» into the person's cash and recorded as a transfer @mobile", async ({ page, request }) => {
    const cashId = await addAccount("Efectivo e2e", "cash");
    const text = `Davivienda: Retiraste $300.000 en CAJERO CALLE 80 con tu T.Deb *1234 el ${DAY} a las 19:05.`;
    const deliveryId = await receive(request, text);

    const [proposal] = await fixtureSql<{ direction: string; to: string | null; category: string | null; description: string | null }[]>`
      select proposed_direction as direction, proposed_to_account_id as to, proposed_category_id as category,
        proposed_description as description
      from ingest_deliveries where id = ${deliveryId}`;
    expect(proposal).toEqual({ direction: "transfer", to: cashId, category: null, description: "Retiro en cajero" });

    await page.goto("/es/inbox");
    await expect(band(page).getByText(ingest.kindWithdrawal, { exact: true }).first()).toBeVisible();
    await acceptButton(page).click();

    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
    const movements = await fixtureSql<{ from: string; to: string; amount: string; splits: number }[]>`
      select t.from_account_id as from, t.to_account_id as to, t.amount_cents::text as amount,
        (select count(*)::int from transaction_splits s where s.transaction_id = t.id) as splits
      from transactions t where t.owner_user_id = ${scope.userId}`;
    expect(movements).toEqual([{ from: scope.accountId, to: cashId, amount: "30000000", splits: 0 }]);
  });

  async function addDebt(name: string, subtype: "card" | "loan", lastFour: string | null): Promise<string> {
    const id = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (id, owner_user_id, name, kind, subtype, last_four, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${name}, 'liability', ${subtype}, ${lastFour}, -2000000, '2025-01-01')`;
    });
    created.accounts.push(id);
    return id;
  }

  test("a card purchase whose ending matches no card asks which card, is never batched and never touches a loan @mobile", async ({
    page,
    request,
  }) => {
    // «T.Cred» starts the name «Crédito carro»: the loan is the account the old reading proposed.
    const loanId = await addDebt("Crédito carro e2e", "loan", null);
    await addDebt("Visa e2e", "card", "1111");
    const deliveryId = await receive(
      request,
      `Bancolombia: Compraste $85.400 en EXITO con tu T.Cred *7788 el ${DAY} a las 19:05.`,
    );

    const [proposal] = await fixtureSql<{ account: string | null }[]>`
      select proposed_account_id as account from ingest_deliveries where id = ${deliveryId}`;
    expect(proposal.account).toBeNull();

    await page.goto("/es/inbox");
    await expect(band(page).getByText(ingest.cardMissing, { exact: true }).first()).toBeVisible();
    // Not ready: no checkbox to batch it and no one-tap «Anotar».
    await expect(band(page).getByRole("checkbox")).toHaveCount(0);
    await expect(acceptButton(page)).toHaveCount(0);

    const touched = await fixtureSql`
      select id from transactions where from_account_id = ${loanId} or to_account_id = ${loanId}`;
    expect(touched).toHaveLength(0);
  });

  test("a card purchase proposes the card whose last four match @mobile", async ({ request }) => {
    await addDebt("Crédito carro e2e", "loan", null);
    const visaId = await addDebt("Visa e2e", "card", "7788");
    const deliveryId = await receive(
      request,
      `Bancolombia: Compraste $85.400 en EXITO con tu T.Cred *7788 el ${DAY} a las 19:05.`,
    );

    const [proposal] = await fixtureSql<{ account: string | null }[]>`
      select proposed_account_id as account from ingest_deliveries where id = ${deliveryId}`;
    expect(proposal.account).toBe(visaId);
  });

  test("the card changes the kind and the account, as the wide screen does @mobile", async ({ page }) => {
    const otherId = await addAccount("Otra cuenta e2e", "bank");
    await seedQueue([complete]);
    await page.goto("/es/inbox");

    // To an income: the expense category falls away and the card asks for an income one.
    await page.getByRole("radio", { name: ingest.kindIncome, exact: true }).click();
    await expect(band(page).getByText(ingest.categoryMissing, { exact: true })).toBeVisible();
    await expect(reviewButton(page)).toHaveCount(1);

    // Back to an expense on another account: ready again, and recorded on that account.
    await page.getByRole("radio", { name: ingest.kindExpense, exact: true }).click();
    await page.getByRole("combobox", { name: ingest.accountLabel }).click();
    await page.getByRole("option", { name: "Otra cuenta e2e", exact: true }).click();
    await page.getByRole("combobox", { name: ingest.categoryLabel }).click();
    await page.getByRole("option", { name: scope.categoryName, exact: true }).click();
    await acceptButton(page).click();

    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
    const [movement] = await fixtureSql<{ from: string | null }[]>`
      select from_account_id as from from transactions where owner_user_id = ${scope.userId}`;
    expect(movement.from).toBe(otherId);
  });

  test("the card turns an expense into a move between the person's own accounts @mobile", async ({ page }) => {
    const otherId = await addAccount("Otra cuenta e2e", "bank");
    await seedQueue([complete]);
    await page.goto("/es/inbox");

    await page.getByRole("radio", { name: ingest.kindTransfer, exact: true }).click();
    await expect(reviewButton(page)).toHaveCount(1);
    await page.getByRole("combobox", { name: ingest.toAccountLabel }).click();
    await page.getByRole("option", { name: "Otra cuenta e2e", exact: true }).click();
    await acceptButton(page).click();

    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
    const [movement] = await fixtureSql<{ from: string; to: string }[]>`
      select from_account_id as from, to_account_id as to from transactions where owner_user_id = ${scope.userId}`;
    expect(movement).toEqual({ from: scope.accountId, to: otherId });
  });

  test("a merchant's own name, not the SMS around it, becomes the description @mobile", async ({ request }) => {
    const sent = [
      [`Bancolombia le informa Compra por $38.000 en RAPPI RESTAURANTE 15:32. ${DAY} T.Cred *4521. Inquietudes al 018000000000.`, "Rappi Restaurante"],
      [`Davivienda: Compra aprobada por $52.300 en EXITO COLINA con tu T.Cred *4521 el ${DAY}.`, "Exito Colina"],
      [`Nequi: Pagaste en UBER TRIP el ${DAY}.`, "Uber Trip"],
    ] as const;
    for (const [text, description] of sent) {
      const id = await receive(request, text);
      const [row] = await fixtureSql<{ description: string | null }[]>`
        select proposed_description as description from ingest_deliveries where id = ${id}`;
      expect(row.description).toBe(description);
    }
  });

  test("a row stored with the sentence cut is recorded under the merchant @mobile", async ({ page }) => {
    await seedQueue([
      {
        ...complete,
        merchant: "RAPPI*",
        text: "Bancolombia le informa Compra por $38.000 en RAPPI RESTAURANTE 15:32. 10/11/2026 T.Cred *4521.",
        description: "Bancolombia le informa Compra por $ en RAPPI* 15:32. 10/11/2026 T.Cred *4521.",
      },
    ]);
    await page.goto("/es/inbox");
    await acceptButton(page).click();

    await expect(page.getByText(ingest.acceptedToast)).toBeVisible();
    const [movement] = await fixtureSql<{ description: string }[]>`
      select description from transactions where owner_user_id = ${scope.userId}`;
    expect(movement.description).toBe("Rappi Restaurante");
  });

  test("a merchant like Exito is proposed Mercado, not the key's blanket default @mobile", async ({ request }) => {
    const groceries = await addCategory("Mercado", "expense");
    const id = await receive(request, `Davivienda: Compra aprobada por $52.300 en EXITO COLINA con tu T.Cred *4521 el ${DAY}.`);

    const [row] = await fixtureSql<{ category: string | null }[]>`
      select proposed_category_id as category from ingest_deliveries where id = ${id}`;
    expect(row.category).toBe(groceries);
  });
});
