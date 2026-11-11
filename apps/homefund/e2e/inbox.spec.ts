/**
 * The debt this slice pays: `/inbox` shipped with done criteria that named a
 * browser and an authenticated session, and was merged without either. Every
 * assertion here is one of those criteria (plan modules 10, 11 and 17).
 *
 * The copy is read from the message file the screen reads, so a rewording moves
 * both at once and never leaves a spec asserting a string nobody renders.
 */
import { expect, type Locator, type Page } from "@playwright/test";

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

    test("says which key a delivery came through, in the row and in the card (RF-194)", async ({
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
      const via = messages.ingest.arrivedVia
        .replace("{kind}", messages.webhooks.kind.android)
        .replace("{name}", "Mi celular e2e");

      await page.goto("/es/inbox");
      await expect(
        page.getByRole("table", { name: ingest.title }).getByText(via),
      ).toBeVisible();

      await page.setViewportSize({ width: 390, height: 800 });
      await expect(page.getByText(via)).toBeVisible();
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
        dialog.getByRole("combobox", { name: transactions.fromLabel }),
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
        dialog.getByRole("combobox", { name: transactions.fromLabel }),
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
