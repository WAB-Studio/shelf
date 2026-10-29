import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RNP-16, RNP-17 (`ArmazonCargando`, `ArmazonNoEncontrada` and their 1440
// faces): the 404 and the loading skeleton stand inside the frame, with the
// header where the real one lands. The failure board is held by `caida.spec.ts`,
// which owns the server whose database is down.
const stamp = Date.now();
const GOAL = `Estados meta ${stamp}`;
const UNKNOWN_GOAL = "00000000-0000-4000-8000-000000000000";

async function seed(db: postgres.Sql, personId: string): Promise<string> {
  const horizon = civilDateToDate(todayInZone());
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${GOAL}, ${dateToCivilDate(horizon)}) returning id
  `;
  return goal.id;
}

async function open(browser: Browser, baseURL: string | undefined, person: Person, width: number, height: number) {
  const context = await browser.newContext({
    baseURL,
    storageState: person.sessionFile,
    viewport: { width, height },
    hasTouch: width < 1024,
  });
  return { context, page: await context.newPage() };
}

const loaded = (page: Page) => expect(page.getByRole("main")).toContainText(/\S/);

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    let goalId = "";
    test.beforeEach(async ({ db, person }) => {
      goalId = await seed(db, person.id);
    });

    test("the 404 draws one h1, a way to Hoy, no way back and the navigation with nothing current", async ({
      browser,
      baseURL,
      person,
    }) => {
      const { context, page } = await open(browser, baseURL, person, width, 900);
      await page.goto(`/metas/${UNKNOWN_GOAL}`);
      await loaded(page);
      await expect(page.getByRole("heading")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
      await expect(page.getByRole("main").getByRole("link", { name: "Ir a hoy" })).toHaveAttribute("href", "/");
      await expect(page.getByRole("main").getByRole("link", { name: "Ver las metas" })).toHaveAttribute("href", "/metas");
      await expect(page.getByRole("link", { name: /^Volver a / })).toHaveCount(0);
      await expect(page.getByText("la encuentras en Metas")).toBeVisible();

      const nav = page.getByRole("navigation");
      await expect(nav.getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ })).toHaveCount(4);
      if (width >= 1024) await expect(nav.getByRole("link", { name: GOAL })).toBeVisible();
      await expect(page.locator("a[aria-current]")).toHaveCount(0);

      // The exit block (`ScreenExit`) as the board draws it.
      const first = await page.getByRole("main").getByRole("link", { name: "Ir a hoy" }).boundingBox();
      const second = await page.getByRole("main").getByRole("link", { name: "Ver las metas" }).boundingBox();
      const main = await page.getByRole("main").boundingBox();
      if (width >= 1024) {
        expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
        expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1);
        expect(second!.x + second!.width - first!.x).toBeLessThanOrEqual(560);
      } else {
        expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
        expect(first!.width).toBeCloseTo(second!.width, 0);
        expect(first!.width).toBeGreaterThan(main!.width - 64);
      }
      await context.close();
    });

    // The skeleton's block stands where a real header lands (`/mes`) and is as
    // tall as one with a way back and a title only (`phase-form`).
    test("a route held in loading shows the header block where the header lands", async ({
      browser,
      baseURL,
      person,
    }) => {
      const { context, page } = await open(browser, baseURL, person, width, 900);
      await page.goto(`/metas/${goalId}/fases/nueva`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const withBack = await page.locator("main header").first().boundingBox();
      await page.goto("/mes");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const landed = await page.locator("main header").first().boundingBox();

      // The skeleton shows only once the link's prefetch has landed `loading`
      // in the router cache; clicking before it leaves the screen blank.
      const prefetched = page.waitForResponse(
        (res) => new URL(res.url()).pathname === "/mes" && res.request().headers()["next-router-prefetch"] !== undefined,
      );
      await page.goto("/");
      await loaded(page);
      await prefetched;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      await page.route("**/mes**", async (route) => {
        const headers = route.request().headers();
        if (headers["rsc"] === "1" && headers["next-router-prefetch"] === undefined) await gate;
        await route.continue();
      });

      await page.getByRole("navigation").getByRole("link", { name: "Mes" }).first().click();
      const block = page.locator("main header[aria-hidden]");
      await expect(block).toBeVisible();
      await expect(page.getByRole("heading")).toHaveCount(0);
      const held = await block.boundingBox();
      expect(Math.abs(held!.y - landed!.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(held!.height - withBack!.height)).toBeLessThanOrEqual(2);

      release();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(block).toHaveCount(0);
      await context.close();
    });
  });
}

test("at 360 the 404 does not overflow", async ({ browser, baseURL, person }) => {
  const { context, page } = await open(browser, baseURL, person, 360, 740);
  await page.goto(`/metas/${UNKNOWN_GOAL}`);
  await loaded(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});
