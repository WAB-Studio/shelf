/**
 * The queue's two navigation surfaces and the dashboard badge that points at it
 * (plan modules 13 and 17). The sheet closing on a navigation and the badge
 * collapsing at zero are rendered states no headless check reaches.
 */
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import {
  asHarnessUser,
  clearLedger,
  clearQueue,
  readScope,
  seedQueue,
  test,
} from "./global-setup";

const nav = messages.nav;

const scope = readScope();

const MERCHANT = "Comercio de la bandeja";

const pending = {
  merchant: MERCHANT,
  amountCents: 4500000,
  accountId: scope.accountId,
  categoryId: scope.categoryId,
  categorySource: "merchant" as const,
  trusted: true,
};

// The `one` branch of an ICU plural with `#` filled: the badge's caption at one
// waiting delivery, taken from the message the screen renders.
function atOne(message: string): string {
  return (/one \{([^}]*)\}/.exec(message)?.[1] ?? message).replace("#", "1");
}

const PENDING_BADGE = atOne(messages.dashboard.pendingDeliveriesBadge);

test.describe("the desktop sidebar", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 1280,
    "the sidebar renders from md up",
  );

  // Both were unreachable on a laptop before the sidebar: neither had a link
  // anywhere outside the bottom bar, which never renders at this width.
  test("reaches movements and reports from another screen, and lights the one it lands on", async ({
    page,
  }) => {
    await page.goto("/es/planning");
    const sidebar = page.getByRole("navigation", { name: nav.title });

    await expect(
      sidebar.getByRole("link", { name: nav.reports, exact: true }),
    ).toHaveAttribute("href", "/es/reports");

    const movements = sidebar.getByRole("link", { name: nav.movements, exact: true });
    await movements.click();
    await expect(page).toHaveURL("/es/movements");
    await expect(movements).toHaveAttribute("aria-current", "page");
  });

  test("opens quick entry away from the dashboard", async ({ page }) => {
    await page.goto("/es/planning");
    await page.getByRole("button", { name: nav.record, exact: true }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

test.describe("the phone's navigation", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 360,
    "the bottom bar and its sheet render below md",
  );

  test("reaches the inbox from its tab and Planeación from the settings sheet @mobile", async ({
    page,
  }) => {
    await page.goto("/es");
    await page
      .getByRole("navigation")
      .getByRole("link", { name: new RegExp(`^${nav.inbox}(,|$)`) })
      .click();
    await expect(page).toHaveURL("/es/inbox");

    await page.getByRole("button", { name: nav.settings, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("link", { name: nav.planning, exact: true }).click();
    await expect(page).toHaveURL("/es/planning");
    await expect(sheet).toBeHidden();
  });

  // RF-202: the count rides the Bandeja tab, hidden at zero, and Ajustes carries none.
  test("carries the inbox count on the Bandeja tab and not on Ajustes @mobile", async ({
    page,
  }) => {
    await seedQueue([pending]);
    await page.goto("/es");
    await expect(
      page.getByRole("navigation").getByRole("link", { name: new RegExp(`^${nav.inbox},`) }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: nav.settings, exact: true })).toBeVisible();
  });

  // RF-198: the phone has no Ajustes screen of its own, so the sheet carries the sign-in limit.
  test("offers «Mantener la sesión abierta» in the settings sheet @mobile", async ({ page }) => {
    await page.goto("/es");
    await page.getByRole("button", { name: new RegExp(`^${nav.settings}(,|$)`) }).click();

    await expect(
      page.getByRole("dialog").getByRole("combobox", { name: messages.session.label }),
    ).toBeVisible();
  });

  test("keeps its three tabs, each at least 32 px on its shorter side @mobile", async ({
    page,
  }) => {
    await page.goto("/es");

    for (const label of [nav.home, nav.movements, nav.inbox]) {
      const tab = page
        .getByRole("navigation")
        .getByRole("link", { name: new RegExp(`^${label}(,|$)`) });
      await expect(tab).toBeVisible();

      const box = await tab.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      expect(Math.min(box!.width, box!.height), label).toBeGreaterThanOrEqual(32);
    }
  });
});

test.describe("the dashboard's pending badge", () => {
  test("carries the count and reaches the inbox in one tap", async ({ page }) => {
    await seedQueue([pending]);
    await page.goto("/es");

    const badge = page.getByRole("link", { name: PENDING_BADGE, exact: true });
    await expect(badge).toBeVisible();

    await badge.click();
    await expect(page).toHaveURL("/es/inbox");
  });
});

// RF-201: the empty Bandeja names the four places things arrive from, each a link to its card.
test("the empty inbox links each source to its place in Ajustes", async ({ page }) => {
  await clearQueue();
  await page.goto("/es/inbox");

  const sources = messages.ingest.emptySource;
  for (const [key, anchor] of [
    ["android", "android"],
    ["iphone", "iphone"],
    ["gmail", "bank-emails"],
    ["claude", "claude"],
  ] as const) {
    await expect(
      page.getByRole("link", { name: sources[key].link, exact: true }).filter({ visible: true }),
    ).toHaveAttribute("href", `/es/settings/webhooks#${anchor}`);
  }
});

// RF-200: Inicio's badge, the sidebar and the phone's bar count one sum.
test("a movement waiting for its counterparty counts in Inicio's badge", async ({ page }) => {
  await clearQueue();
  await asHarnessUser(async (tx) => {
    const [movement] = await tx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description, awaiting_counterparty)
      values (${scope.accountId}, 1000000, (now() at time zone 'America/Bogota')::date, 'Por completar badge', true)
      returning id`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${movement.id}, ${scope.categoryId}, 1000000)`;
  });
  try {
    await page.goto("/es");
    await expect(page.getByRole("link", { name: PENDING_BADGE, exact: true })).toBeVisible();
  } finally {
    await clearLedger();
  }
});
