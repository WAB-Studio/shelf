/**
 * Where focus is and whether a primary label reads (WCAG 1.4.11 and 1.4.3), as
 * computed style on the sign-in page: its button is the primary `Button`, and
 * its field is the first stop of the Tab order.
 *
 * Ratios are computed here from the colours the browser resolved, never from a
 * hand-copied hex.
 */
import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { test } from "./global-setup";

const signedOut = { cookies: [], origins: [] };
test.use({ storageState: signedOut });
test.skip(({ viewport }) => viewport?.width === 360, "the tokens are read once, on the laptop");

function channels(rgb: string): [number, number, number] {
  const [r, g, b] = rgb.match(/[\d.]+/g)!.map(Number);
  return [r, g, b];
}

function luminance(rgb: string): number {
  const [r, g, b] = channels(rgb).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Resolves a CSS colour (token or literal) to the `rgb(…)` string the browser computes.
async function resolved(page: Page, value: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.querySelector(".radix-themes")!.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);
}

async function open(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.goto("/es/login");
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
}

const send = (page: Page) => page.getByRole("button", { name: messages.auth.sendLink, exact: true });

test.describe("light", () => {
  test.beforeEach(async ({ page }) => open(page, "light"));

  test("a focused button outlines in jade-11", async ({ page }) => {
    await page.getByLabel(messages.auth.emailLabel).fill("a@b.invalid");
    await page.keyboard.press("Tab");
    await expect(send(page)).toBeFocused();
    await expect(send(page)).toHaveCSS("outline-color", await resolved(page, "var(--jade-11)"));
    await expect(send(page)).toHaveCSS("outline-style", "solid");
  });

  test("the focus ring reaches 3:1 on the ground", async ({ page }) => {
    const ground = await resolved(page, "var(--color-background)");
    const ring = await resolved(page, "var(--focus-8)");
    expect(ratio(ring, ground)).toBeGreaterThanOrEqual(3);
  });

  test("the primary button's white label reads at 4.5:1", async ({ page }) => {
    const bg = await send(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const label = await send(page).evaluate((el) => getComputedStyle(el).color);
    expect(label).toBe("rgb(255, 255, 255)");
    expect(ratio(bg, label)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(await resolved(page, "var(--accent-10)"), "rgb(255, 255, 255)")).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("dark", () => {
  test.beforeEach(async ({ page }) => open(page, "dark"));

  test("the focus ring stays the accent's own step", async ({ page }) => {
    expect(await resolved(page, "var(--focus-8)")).toBe(await resolved(page, "var(--accent-8)"));
    expect(await resolved(page, "var(--accent-9)")).toBe(await resolved(page, "#29a383"));
  });
});
