import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// Runs against the `desktop` project alone (playwright.config.ts scopes it
// there): 1280x800, no touch. docs/voyager/DESIGN.md "Viewport": the bar
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
    await page.waitForTimeout(300);

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

test("the reading column on / keeps its 620px measure and clears the sidebar", async ({ page }) => {
  await disableTranslator(page);
  await page.goto("/");
  await page.waitForTimeout(300);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  const navBox = await page.getByRole("navigation", { name: messages.nav.label }).boundingBox();
  const mainBox = await page.locator("main").boundingBox();
  expect(navBox).not.toBeNull();
  expect(mainBox).not.toBeNull();

  expect(mainBox!.width).toBeLessThanOrEqual(620.5);

  // page.module.css's own 1024px block: the sidebar's 240px plus half of
  // whatever the viewport, the sidebar and the 620px column leave over. A
  // floor alone — "a gap bigger than 20px" — also passes if that block
  // never fires: the 660px rule's plain `margin-inline: auto` centres the
  // 620px column on the full 1280px viewport instead (x≈330, gap≈90) and
  // clears 20px by coincidence. Pinning the exact x this formula produces
  // is what tells the two apart.
  const expectedX = 240 + (viewport!.width - 240 - 620) / 2;
  expect(mainBox!.x).toBeGreaterThan(expectedX - 2);
  expect(mainBox!.x).toBeLessThan(expectedX + 2);

  // Centred in what is left of the viewport, not stuck to the sidebar's
  // own right edge — a real gap, not a hairline.
  const gap = mainBox!.x - (navBox!.x + navBox!.width);
  expect(gap).toBeGreaterThan(20);
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
    await page.waitForTimeout(300);

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
