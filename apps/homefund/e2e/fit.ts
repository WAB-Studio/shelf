import type { Locator, Page } from "@playwright/test";

// The narrowest a title gives way beside a figure on a phone: 7rem.
export const MIN_TITLE_PX = 7 * 16;

/** How far the page scrolls sideways; zero or less when it fits. */
export function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** How far `inner`'s right edge runs past `outer`'s; zero or less when inside. */
export async function rightOverhang(inner: Locator, outer: Locator): Promise<number> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return a!.x + a!.width - (b!.x + b!.width);
}
