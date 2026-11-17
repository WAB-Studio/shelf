/**
 * Inicio for someone with no accounts yet draws the first-account guide at the
 * desktop width, never the error screen (RF-155). The second harness identity
 * owns nothing, so it is the person who has never opened an account; it runs
 * once with no fund and once leading an empty one, the two states the guide's
 * «Crear un fondo» link tells apart.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { asUser, clearGroup, MEMBER_STORAGE_STATE, readScope, test } from "./global-setup";

const home = messages.dashboard;

test.use({
  storageState: MEMBER_STORAGE_STATE,
  viewport: { width: 1280, height: 800 },
});

async function expectGuide(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/es");

  await expect(page.getByRole("heading", { name: home.firstAccountTitle })).toBeVisible();
  await expect(page.getByText(messages.errors.unexpected)).toHaveCount(0);
  expect(errors.filter((text) => text.includes("Slot"))).toEqual([]);
}

test("shows the first-account guide at 1280 px with no fund", async ({ page }) => {
  await expectGuide(page);
  await expect(page.getByRole("main").getByRole("link", { name: home.createFund })).toBeVisible();
});

test("Ajustes keeps «Crear un fondo» reachable with no fund, at 1280 px", async ({ page }) => {
  await page.goto("/es/settings");

  const entry = page.getByRole("link", { name: messages.nav.createFund, exact: true }).filter({ visible: true });
  await expect(entry.first()).toBeVisible();
  await entry.first().click();
  await expect(page).toHaveURL(/\/es\/onboarding/);
});

test.describe("leading an empty fund", () => {
  test.beforeAll(async () => {
    const { memberUserId } = readScope();
    const groupId = randomUUID();
    await asUser(memberUserId, async (tx) => {
      await tx`insert into groups (id, name, cash_mode) values (${groupId}, 'Fondo vacio', 'per_member')`;
      await tx`insert into group_members (group_id, user_id, name, role) values (${groupId}, ${memberUserId}, 'Solo', 'leader')`;
    });
  });

  test.afterAll(clearGroup);

  test("shows the first-account guide at 1280 px", async ({ page }) => {
    await expectGuide(page);
  });

  test("Ajustes no longer offers «Crear un fondo»", async ({ page }) => {
    await page.goto("/es/settings");

    await expect(page.getByRole("link", { name: messages.nav.fundSettings }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: messages.nav.createFund, exact: true })).toHaveCount(0);
  });
});
