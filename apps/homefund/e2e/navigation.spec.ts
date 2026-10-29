/**
 * The queue's two navigation surfaces and the dashboard badge that points at it
 * (plan modules 13 and 17). The sheet closing on a navigation and the badge
 * collapsing at zero are rendered states no headless check reaches.
 */
import { expect } from "@playwright/test";

import messages from "@/messages/es.json";

import {
  clearLedger,
  clearQueue,
  readScope,
  seedQueue,
  seedUnreviewedMovement,
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

  test("reaches the inbox from the settings sheet, which closes behind it", async ({
    page,
  }) => {
    await page.goto("/es");
    await page.getByRole("button", { name: nav.settings, exact: true }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("link", { name: nav.inbox, exact: true }).click();
    await expect(page).toHaveURL("/es/inbox");
    await expect(sheet).toBeHidden();
  });

  test("keeps its three tabs, each at least 32 px on its shorter side", async ({
    page,
  }) => {
    await page.goto("/es");

    for (const label of [nav.home, nav.movements, nav.planning]) {
      const tab = page.getByRole("link", { name: label, exact: true });
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

  test("leaves no gap at zero", async ({ page }) => {
    test.skip(
      test.info().project.name !== "mobile",
      "the badge and the month figures share a column only below md: from there up they are two cards of the Inicio row, side by side",
    );

    // No generated movement either: the other badge would hold the row open.
    await clearLedger();
    await seedQueue([pending]);
    await page.goto("/es");

    const below = page.getByText(messages.dashboard.monthIncome, { exact: true });
    // Painted before it is measured: `boundingBox` waits for the element to be
    // attached and answers null for anything the layout has not placed yet.
    await expect(below).toBeVisible();
    const withBadge = await below.boundingBox();

    await clearQueue();
    await page.reload();
    // The gate goes first here too, so the count below is read off the dashboard
    // this reload drew and not off a document still on its way.
    await expect(below).toBeVisible();
    await expect(
      page.getByRole("link", { name: PENDING_BADGE, exact: true }),
    ).toHaveCount(0);

    // The row is conditional, not merely empty: what stood below it moves up by
    // the badge's own height rather than keeping its place.
    const withoutBadge = await below.boundingBox();
    expect(withBadge).not.toBeNull();
    expect(withoutBadge).not.toBeNull();
    expect(withoutBadge!.y).toBeLessThan(withBadge!.y);
  });

  test("sits beside the unreviewed badge with no overflow at 360 px", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "mobile",
      "RNF-08's base case is the mobile project's viewport",
    );

    await clearLedger();
    await seedQueue([pending]);
    await seedUnreviewedMovement();
    await page.goto("/es");

    await expect(
      page.getByRole("link", { name: PENDING_BADGE, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /sin revisar/ })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
