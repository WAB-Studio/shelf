import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// Runs against the `desktop` project alone (playwright.config.ts scopes it
// there): 1280x800, no touch. docs/wordbook/DESIGN.md "Viewport": the bar
// becomes a sidebar at 1024px, a second breakpoint distinct from the ~660px
// the reading column centres above.

const ROUTES = [
  { path: "/", key: "search" },
  { path: "/registro", key: "log" },
  { path: "/cuenta", key: "account" },
] as const;

async function disableTranslator(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

test("one <nav> at the side on every route, never a bar at the foot", async ({ page }) => {
  await disableTranslator(page);

  for (const { path, key } of ROUTES) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // A single implementation, one media query: proven by count, not read
    // off the markup (docs/TRAPS.md "An unscoped locator finds both bands
    // at once" — a role locator already tells two trees from one).
    const navs = page.getByRole("navigation", { name: messages.nav.label });
    await expect(navs).toHaveCount(1);

    const box = await navs.boundingBox();
    expect(box).not.toBeNull();
    // Pinned to the left edge, spanning the full viewport height: a side
    // rail, never a short strip sitting at the foot.
    expect(box!.x).toBeLessThan(1);
    expect(box!.width).toBeGreaterThan(238);
    expect(box!.width).toBeLessThan(242);
    expect(box!.height).toBeGreaterThan(700);

    const current = navs.getByRole("link", { name: messages.nav[key] });
    await expect(current).toHaveAttribute("aria-current", "page");
    for (const other of ROUTES) {
      if (other.key === key) continue;
      await expect(navs.getByRole("link", { name: messages.nav[other.key] })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  }
});

test("from 1280px the main screen is two panels in what the sidebar leaves: the entry and a 380px side", async ({ page }) => {
  await disableTranslator(page);
  // An answer keeps its second panel; the empty screen draws one only once the record has a review to offer.
  await page.goto("/?q=throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  const navBox = await page.getByRole("navigation", { name: messages.nav.label }).boundingBox();
  const panels = await page.locator("main > div").first().boundingBox();
  const side = await page.locator("main aside").boundingBox();
  const field = await page.getByRole("textbox", { name: messages.search.label }).boundingBox();
  expect(navBox).not.toBeNull();
  expect(panels).not.toBeNull();
  expect(side).not.toBeNull();
  expect(field).not.toBeNull();

  // The sidebar's 240px and the page's 32px padding on both sides; the panels keep 1120px at most.
  const room = viewport!.width - 240 - 64;
  expect(Math.abs(panels!.width - Math.min(1120, room))).toBeLessThan(2);
  expect(panels!.x).toBeGreaterThanOrEqual(navBox!.x + navBox!.width);
  expect(Math.abs(side!.width - 380)).toBeLessThan(1);
  expect(side!.x + side!.width).toBeLessThanOrEqual(panels!.x + panels!.width + 1);
  // The box lives in the entry's panel, left of the side.
  expect(field!.x + field!.width).toBeLessThanOrEqual(side!.x);
});

// `measure="full"` shipped with the 660px rule's `width: 100%` still in
// force under the 1024px rule that pushes it past the sidebar, so every one
// of these three routes scrolled sideways by exactly the sidebar's own
// 240px band. The suite was green: `escritorio.spec.ts` measured the
// reading column, and `full` is the other branch of the same stylesheet.
for (const route of ["/registro", "/registro/apple", "/cuenta"]) {
  test(`${route} takes the width left of the sidebar without scrolling the page sideways`, async ({ page }) => {
    await disableTranslator(page);
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBe(clientWidth);

    // Starts after the sidebar and ends at the viewport's own edge: the
    // width equality above passes just as well for a `main` that never
    // cleared the sidebar at all.
    const mainBox = await page.locator("main").boundingBox();
    expect(mainBox).not.toBeNull();
    expect(mainBox!.x).toBe(240);
    expect(Math.round(mainBox!.x + mainBox!.width)).toBe(viewport!.width);
  });
}

test("RNL-03: at 1440px the box and the answer sit in the left panel, beside the 380px side", async ({ page }) => {
  await disableTranslator(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?q=throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);

  const panels = await page.locator("main > div").first().boundingBox();
  const side = await page.locator("main aside").boundingBox();
  const searchBox = await page.getByRole("textbox", { name: messages.search.label }).boundingBox();
  const answer = await page.getByRole("heading", { name: "throughout" }).boundingBox();
  expect(panels).not.toBeNull();
  expect(side).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(answer).not.toBeNull();

  // 1120px centred in what the sidebar leaves.
  expect(Math.abs(panels!.width - 1120)).toBeLessThan(2);
  expect(Math.abs(panels!.x - (240 + (1200 - 1120) / 2))).toBeLessThan(2);
  expect(Math.abs(side!.width - 380)).toBeLessThan(1);
  for (const inner of [searchBox!, answer!]) {
    expect(inner.x).toBeGreaterThanOrEqual(panels!.x - 1);
    expect(inner.x + inner.width).toBeLessThanOrEqual(side!.x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});
