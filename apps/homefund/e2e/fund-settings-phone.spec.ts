/**
 * «Ajustes del fondo» on the phone (RF-55, RF-154; board `AjustesFondoMiembroMovil` and
 * `AjustesSinFondoMovil`). Below `md`, every member of a
 * fund, leader or not, finds «Ajustes del fondo» as the FIRST row of the «Ajustes» list, on the
 * `/settings` screen and in the bottom bar's sheet, and it leads to `/es/settings/group`. A person with
 * no fund sees no such row. From `md` up no list offers it: the chevron beside the fund name owns it.
 *
 * Rows are found by role and accessible name. The words are the product's own (`nav.fundSettings`),
 * the same ones the desktop chevron already carries. The first row is judged by order among the links
 * of the list's surface, not by a class.
 *
 * Fixtures: `seedGroup` before each test makes a fresh fund with the leader and the plain member;
 * `clearGroup` removes it (and gives the no-fund tests their starting point).
 */
import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import {
  MEMBER_STORAGE_STATE,
  clearGroup,
  seedGroup,
  test,
} from "./global-setup";

const nav = messages.nav;
const GROUP_HREF = "/es/settings/group";

test.afterAll(async () => {
  await clearGroup();
});

function isPhone(viewport: { width: number } | null | undefined): boolean {
  return viewport?.width === 360;
}

async function openScreen(page: Page): Promise<Locator> {
  await page.goto("/es/settings");
  const screen = page.getByRole("main");
  await expect(screen.getByRole("link", { name: nav.planning, exact: true })).toBeVisible();
  return screen;
}

async function openSheet(page: Page): Promise<Locator> {
  await page.goto("/es");
  await page.getByRole("button", { name: nav.settings, exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: nav.planning, exact: true })).toBeVisible();
  return sheet;
}

// The visible links of a surface in document order, by href and accessible name.
async function rows(surface: Locator): Promise<{ href: string | null; name: string }[]> {
  const links = await surface.getByRole("link").all();
  return Promise.all(
    links.map(async (link) => ({
      href: await link.getAttribute("href"),
      name: ((await link.textContent()) ?? "").trim(),
    })),
  );
}

// The row that follows it is Planeación, on the screen and in the sheet alike.
async function expectFirstRow(surface: Locator, second: string) {
  const row = surface.getByRole("link", { name: nav.fundSettings, exact: true });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("href", GROUP_HREF);

  const list = await rows(surface);
  expect(list[0]?.name).toBe(nav.fundSettings);
  // The old first row is now second, so the new one is not merely somewhere in the list.
  expect(list[1]?.name).toBe(second);
}

async function expectNoRow(surface: Locator) {
  await expect(surface.getByRole("link", { name: nav.fundSettings })).toHaveCount(0);
  await expect(surface.locator(`a[href="${GROUP_HREF}"]`)).toHaveCount(0);
}

test.describe("at 360, a member of a fund", () => {
  test.skip(({ viewport }) => !isPhone(viewport), "the phone's lists render below md");
  test.use({ storageState: MEMBER_STORAGE_STATE });
  test.beforeEach(async () => {
    await seedGroup();
  });

  test("a plain member finds «Ajustes del fondo» first on the Ajustes screen and lands on the fund's settings @mobile", async ({
    page,
  }) => {
    const screen = await openScreen(page);
    await expectFirstRow(screen, nav.planning);

    await screen.getByRole("link", { name: nav.fundSettings, exact: true }).click();
    await expect(page).toHaveURL(GROUP_HREF);
    await expect(
      page.getByRole("heading", { name: messages.group.title }).first(),
    ).toBeVisible();
  });

  test("a plain member finds it first in the bottom bar's sheet, which closes behind the tap @mobile", async ({
    page,
  }) => {
    const sheet = await openSheet(page);
    await expectFirstRow(sheet, nav.planning);

    await sheet.getByRole("link", { name: nav.fundSettings, exact: true }).click();
    await expect(page).toHaveURL(GROUP_HREF);
    await expect(sheet).toBeHidden();
  });
});

test.describe("at 360, a person with no fund", () => {
  test.skip(({ viewport }) => !isPhone(viewport), "the phone's lists render below md");
  test.beforeEach(async () => {
    await clearGroup();
  });

  test("sees no «Ajustes del fondo» and no «Miembros» on the screen or in the sheet @mobile", async ({
    page,
  }) => {
    // The screen's list leads on Bandeja, the sheet's on Planeación.
    for (const [open, first] of [[openScreen, nav.planning], [openSheet, nav.planning]] as const) {
      const surface = await open(page);
      await expectNoRow(surface);
      await expect(surface.getByRole("link", { name: nav.members, exact: true })).toHaveCount(0);
      // The list is still there: the first row is the one it always had.
      expect((await rows(surface))[0]?.name).toBe(first);
    }
  });
});
