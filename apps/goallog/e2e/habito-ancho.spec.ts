import type { Page } from "@playwright/test";

import { test, expect, settled } from "./fixtures";
import { boxOf } from "./box";
import { dialog, visit } from "./metas-sin-final-seed";
import { TODAY, seedHabit, shift } from "./sin-final-seed";

// RP-113, RNP-16, RNP-17: the habit's screen at the desktop widths. `DESIGN.md` says it is «the same 640 column,
// drawn once», with the way back in the header, the rail, and its two sheets as centred 480 px dialogs.
test.use({ actionTimeout: 6000 });

const WIDTHS = [1024, 1280, 1440];
const TOLERANCE = 1;
const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const monthsAgo = (count: number) => noonOf(shift(TODAY, -30 * count));

const path = (id: string, query = "") => `/metas/habitos/${id}${query}`;

async function open(browser: Parameters<typeof visit>[0], baseURL: string | undefined, person: Parameters<typeof visit>[2], url: string, width: number) {
  const opened = await visit(browser, baseURL, person, url, width);
  await expect(opened.page.getByRole("heading", { level: 1 })).toBeVisible();
  await settled(opened.page);
  return opened;
}

// The widest block `main` holds under its header.
function contentWidth(page: Page) {
  return page.getByRole("main").evaluate((main) => {
    const widths = Array.from(main.children)
      .filter((el) => el.tagName !== "HEADER")
      .map((el) => el.getBoundingClientRect().width);
    return Math.max(0, ...widths);
  });
}

async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function centred(page: Page, width: number, height: number) {
  const sheet = dialog(page);
  await expect(sheet).toBeVisible();
  await expect.poll(async () => (await boxOf(sheet)).width).toBe(480);
  const at = await boxOf(sheet);
  expect(Math.abs(at.x + at.width / 2 - width / 2)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(at.y + at.height / 2 - height / 2)).toBeLessThanOrEqual(TOLERANCE);
}

for (const width of WIDTHS) {
  test.describe(`the habit's screen at ${width}`, () => {
    test("a live habit of 14 months: the 640 column, the rail, the way back, «ver todo» under the table", async ({ person, browser, baseURL, db }) => {
      const id = await seedHabit(db, person.id, `Meditar ${"largo ".repeat(12)}ancho`, { kind: "daily" }, { kind: "tap" }, { created: monthsAgo(14) });
      const { page, context } = await open(browser, baseURL, person, path(id), width);
      try {
        await noOverflow(page, width);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.getByRole("main").locator("header").getByRole("link", { name: "Volver a Metas" })).toBeVisible();
        const rail = page.getByRole("navigation");
        for (const name of ["Hoy", "Semana", "Mes", "Metas"]) await expect(rail.getByRole("link", { name })).toBeVisible();

        if (width >= 1280) {
          expect(Math.abs((await contentWidth(page)) - 640)).toBeLessThanOrEqual(TOLERANCE);
        }

        // From 1024 to 1279 the table draws as its stack: whichever of the two is visible.
        const table = page.locator("main table:visible, main ol:visible").first();
        await expect(table).toBeVisible();
        const seeAll = page.getByRole("main").getByRole("link", { name: "ver todo", exact: true });
        await expect(seeAll).toBeVisible();
        const tableBox = await boxOf(table);
        const linkBox = await boxOf(seeAll);
        expect(linkBox.y).toBeGreaterThan(tableBox.y + tableBox.height - TOLERANCE);
        expect(Math.abs(linkBox.x - tableBox.x)).toBeLessThanOrEqual(TOLERANCE);
      } finally {
        await context.close();
      }
    });

    test("«?volver=/mes» names «Volver a Mes» and leads to /mes", async ({ person, browser, baseURL, db }) => {
      const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: monthsAgo(3) });
      const { page, context } = await open(browser, baseURL, person, path(id, "?volver=/mes"), width);
      try {
        const back = page.getByRole("main").locator("header").getByRole("link", { name: "Volver a Mes" });
        await expect(back).toBeVisible();
        await back.click();
        await expect(page).toHaveURL(/\/mes$/);
      } finally {
        await context.close();
      }
    });

    test("«Editar» opens a centred 480 dialog; «Cancelar» closes it and writes nothing; pending disables «Guardando…»", async ({ person, browser, baseURL, db }) => {
      const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: monthsAgo(3) });
      const { page, context } = await open(browser, baseURL, person, path(id), width);
      try {
        await page.getByRole("button", { name: "Editar", exact: true }).click();
        await centred(page, width, 900);
        const sheet = dialog(page);
        await expect(sheet.getByRole("button", { name: "Guardarlo", exact: true })).toBeVisible();
        await sheet.getByLabel("nombre", { exact: true }).fill("Otro nombre");
        await sheet.getByLabel("nota, si quieres", { exact: true }).fill("Otra nota");
        await sheet.getByRole("button", { name: "Cancelar", exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        const [row] = await db<{ name: string; note: string | null }[]>`select name, note from goals.commitments where id = ${id}`;
        expect(row).toEqual({ name: "Meditar", note: null });

        // Held: the save leaves only when released.
        let release = () => {};
        const held = new Promise<void>((done) => (release = done));
        await page.route("**/*", async (route) => {
          if (route.request().method() === "POST" && route.request().headers()["next-action"]) await held;
          await route.continue();
        });
        await page.getByRole("button", { name: "Editar", exact: true }).click();
        await dialog(page).getByRole("button", { name: "Guardarlo", exact: true }).click();
        await expect(dialog(page).getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled();
        release();
        await expect(dialog(page)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«Retirarlo» opens a centred dialog; «Dejarlo como está» closes it and retires nothing", async ({ person, browser, baseURL, db }) => {
      const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: monthsAgo(3) });
      const { page, context } = await open(browser, baseURL, person, path(id), width);
      try {
        await page.getByRole("button", { name: "Retirarlo", exact: true }).click();
        await centred(page, width, 900);
        await dialog(page).getByRole("button", { name: "Dejarlo como está", exact: true }).click();
        await expect(dialog(page)).toHaveCount(0);
        const [row] = await db<{ retired_at: Date | null }[]>`select retired_at from goals.commitments where id = ${id}`;
        expect(row.retired_at).toBeNull();
      } finally {
        await context.close();
      }
    });

    test("a retired habit: «retirado el …», neither «Editar» nor «Retirarlo», no overflow", async ({ person, browser, baseURL, db }) => {
      const id = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: monthsAgo(3), retired: noonOf(shift(TODAY, -1)) });
      const { page, context } = await open(browser, baseURL, person, path(id), width);
      try {
        await expect(page.getByRole("main")).toContainText(/retirado el /);
        await expect(page.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
        await noOverflow(page, width);
        if (width >= 1280) expect(Math.abs((await contentWidth(page)) - 640)).toBeLessThanOrEqual(TOLERANCE);
      } finally {
        await context.close();
      }
    });
  });
}

test("a habit created today says «aún sin semanas cerradas» at 1280 without overflow", async ({ person, browser, baseURL, db }) => {
  const id = await seedHabit(db, person.id, "Meditar", { kind: "times_per_week", n: 3 }, { kind: "tap" }, { created: new Date() });
  const { page, context } = await open(browser, baseURL, person, path(id), 1280);
  try {
    await expect(page.getByRole("main")).toContainText("aún sin semanas cerradas");
    await noOverflow(page, 1280);
  } finally {
    await context.close();
  }
});
