import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";

// docs/wordbook/DESIGN.md's grounds: light `#faf8f2`, dark `#14130f`.
const LIGHT_GROUND = "rgb(250, 248, 242)";
const DARK_GROUND = "rgb(20, 19, 15)";

async function ground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rl-ground").trim());
}

async function groundColour(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--rl-ground)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
}

test("RNL-07: with no choice the app opens in the system's mode, and the control names it", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/cuenta");
  expect(await groundColour(page)).toBe(DARK_GROUND);
  await expect(page.getByRole("radio", { name: messages.theme.dark })).toBeChecked();

  await page.emulateMedia({ colorScheme: "light" });
  expect(await groundColour(page)).toBe(LIGHT_GROUND);
  await expect(page.getByRole("radio", { name: messages.theme.light })).toBeChecked();
});

test("RNL-07: «Oscuro» chosen on a light system holds on this device across a reload, and «Claro» takes it back", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/cuenta");
  await page.getByRole("radio", { name: messages.theme.dark }).click();
  expect(await groundColour(page)).toBe(DARK_GROUND);

  await page.reload();
  // Applied before the first paint: the ground is dark the moment the document is read.
  expect(await ground(page)).toBe("#14130f");
  await expect(page.getByRole("radio", { name: messages.theme.dark })).toBeChecked();

  await page.getByRole("radio", { name: messages.theme.light }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await groundColour(page)).toBe(LIGHT_GROUND);
});

test("RNL-07: at 1280px the control sits at the sidebar's foot, and /cuenta carries none of its own", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/cuenta");
  const controls = page.getByRole("radiogroup", { name: messages.theme.label });
  await expect(controls).toHaveCount(1);
  await expect(page.getByRole("navigation").getByRole("radiogroup", { name: messages.theme.label })).toBeVisible();
});

test("RNL-07: tapping the mode already on screen keeps it, so the system switching later does not move it", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/cuenta");
  const dark = page.getByRole("radio", { name: messages.theme.dark });
  await expect(dark).toBeChecked();
  await dark.click();

  await page.emulateMedia({ colorScheme: "light" });
  expect(await groundColour(page)).toBe(DARK_GROUND);
});
