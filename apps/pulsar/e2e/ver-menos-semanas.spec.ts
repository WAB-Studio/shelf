import type { Locator, Page } from "@playwright/test";

import { todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { between, mainLower, PAGES, seedOpenGoal, visit } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf, seedHabit, shift } from "./sin-final-seed";

// Module 966, RP-118: «Por semana» of a goal with no end and a habit's months, opened whole with `?todo=1`, say
// «ver menos» under the label and again where «ver todo» was; it returns to the same screen without `todo=1`,
// keeping `volver`. A list that does not fold draws none. Boards: VerMenos 3 and 4 (private/tableros-s7/NOTAS.md).
// Written from the contract. Every date is relative to today. Each test names its mutation.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const MONTH_RE = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}/g;

const seeLess = (scope: Page | Locator) => scope.getByRole("link", { name: "ver menos", exact: true });
const seeAll = (scope: Page | Locator) => scope.getByRole("link", { name: "ver todo", exact: true });
const weekRows = (page: Page) => page.locator("main ol > li:visible, main tbody tr:visible");
const rowsOf = (section: string) => section.match(MONTH_RE) ?? [];

const weeksAgo = (n: number) => noonOf(shift(weekOf(todayInZone())[0], -7 * n));
const noEnd = (db: Parameters<typeof seedOpenGoal>[0], person: Parameters<typeof seedOpenGoal>[1], name: string, weeks: number) =>
  seedOpenGoal(db, person, { name, unit: PAGES, horizon: null, created: weeksAgo(weeks - 1) });
const habit20 = (db: Parameters<typeof seedHabit>[0], person: { id: string }, months: number) =>
  seedHabit(db, person.id, "Bañarse", { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStartOf(-(months - 1))) });

const weekPath = (id: string, query = "") => `/metas/${id}/revision${query}`;
const habitPath = (id: string, query = "") => `/metas/habitos/${id}${query}`;

test.describe("«Por semana» in `?todo=1` (RP-118)", () => {
  test("146 weeks: «ver menos» twice, both to the same screen without `todo=1`", async ({ person, browser, baseURL, db }) => {
    // Kills: no «ver menos» drawn; only one of the two; an href that keeps `todo=1`.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      for (const i of [0, 1]) expect(await links.nth(i).getAttribute("href")).toBe(weekPath(id));
      await expect(weekRows(page)).toHaveCount(146);
    } finally {
      await context.close();
    }
  });

  test("the first «ver menos» sits above the first row and the second below the last one", async ({ person, browser, baseURL, db }) => {
    // Kills: both links under the table; both above it; the second left out of the flow.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      const rows = weekRows(page);
      await expect(rows).toHaveCount(146);
      const first = (await rows.first().boundingBox())!;
      const last = (await rows.last().boundingBox())!;
      const top = (await links.first().boundingBox())!;
      const bottom = (await links.last().boundingBox())!;
      expect(top.y + top.height).toBeLessThanOrEqual(first.y);
      expect(bottom.y).toBeGreaterThanOrEqual(last.y + last.height);
    } finally {
      await context.close();
    }
  });

  test("tapping «ver menos» returns to the last 12 weeks with «ver todo» and no «ver menos»", async ({ person, browser, baseURL, db }) => {
    // Kills: a link that reloads the whole list; a folded list that keeps «ver menos»; a folded list that loses «ver todo».
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      await seeLess(page.locator("main")).first().click();
      await expect(weekRows(page)).toHaveCount(12);
      await expect(page).not.toHaveURL(/todo=1/);
      await expect(seeAll(page.locator("main"))).toBeVisible();
      await expect(seeLess(page.locator("main"))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("the bottom «ver menos» works the same as the top one", async ({ person, browser, baseURL, db }) => {
    // Kills: the second link pointing elsewhere (the report, the goal) or keeping `todo=1`.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      await seeLess(page.locator("main")).last().click();
      await expect(weekRows(page)).toHaveCount(12);
      await expect(page).toHaveURL(new RegExp(`${weekPath(id)}$`));
    } finally {
      await context.close();
    }
  });

  test("folded (no `todo`): «ver todo», no «ver menos»", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» drawn on the folded list.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id), 360);
    try {
      await expect(seeAll(page.locator("main"))).toHaveCount(1);
      await expect(seeLess(page.locator("main"))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a list that does not fold draws no «ver menos» in `?todo=1`: 5 weeks, exactly 12, and a goal with an end", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» drawn whenever `all` is true, whether or not the list folds.
    const five = await noEnd(db, person, "Cinco", 5);
    const twelve = await noEnd(db, person, "Doce", 12);
    const monday = shift(weekOf(todayInZone())[0], -203);
    const ended = await seedOpenGoal(db, person, { name: "Inglés B1", unit: PAGES, horizon: shift(monday, 7 * 30), created: noonOf(monday) });
    for (const [id, rows] of [[five, 5], [twelve, 12], [ended, 30]] as const) {
      const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
      try {
        await expect(weekRows(page)).toHaveCount(rows);
        await expect(seeLess(page.locator("main"))).toHaveCount(0);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  test("at 360 «ver menos» fits and the page does not scroll sideways", async ({ person, browser, baseURL, db }) => {
    // Kills: a link wider than the column; a row pushed out by it.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const i of [0, 1]) {
        const box = (await links.nth(i).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
      }
    } finally {
      await context.close();
    }
  });
});

test.describe("a habit's months in `?todo=1` (RP-118)", () => {
  test("«Bañarse» with 20 months: all 20 rows, «ver menos» twice, both to the habit without `todo=1`", async ({ person, browser, baseURL, db }) => {
    // Kills: no «ver menos» on the habit; only one; an href that keeps `todo=1`.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      for (const i of [0, 1]) expect(await links.nth(i).getAttribute("href")).toBe(habitPath(id));
      expect(rowsOf(between(await mainLower(page), "por mes"))).toEqual(Array.from({ length: 20 }, (_, i) => monthLabel(i - 19)));
    } finally {
      await context.close();
    }
  });

  test("the first «ver menos» sits above the first month and the second below the last", async ({ person, browser, baseURL, db }) => {
    // Kills: both links under the table; both above it.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      const first = (await page.getByText(monthLabel(-19), { exact: false }).first().boundingBox())!;
      const last = (await page.getByText(monthLabel(0), { exact: false }).first().boundingBox())!;
      const top = (await links.first().boundingBox())!;
      const bottom = (await links.last().boundingBox())!;
      expect(top.y + top.height).toBeLessThanOrEqual(first.y);
      expect(bottom.y).toBeGreaterThanOrEqual(last.y + last.height);
    } finally {
      await context.close();
    }
  });

  test("tapping «ver menos» returns to the last 12 months with «ver todo» and no «ver menos»", async ({ person, browser, baseURL, db }) => {
    // Kills: a link that reloads the whole list; a folded list that keeps «ver menos»; a folded list that loses «ver todo».
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      await seeLess(page.locator("main")).last().click();
      await expect(seeAll(page.locator("main"))).toBeVisible();
      await expect(page).not.toHaveURL(/todo=1/);
      expect(rowsOf(between(await mainLower(page), "por mes"))).toEqual(Array.from({ length: 12 }, (_, i) => monthLabel(i - 11)));
      await expect(seeLess(page.locator("main"))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("from «Mes» (`volver=/mes`) both «ver menos» keep `volver` and drop `todo`", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» losing `volver` (the way back then reads «Metas»); keeping `todo=1`.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?volver=/mes&todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      for (const i of [0, 1]) expect(await links.nth(i).getAttribute("href")).toBe(habitPath(id, "?volver=/mes"));
      await links.first().click();
      await expect(seeAll(page.locator("main"))).toBeVisible();
      const url = new URL(page.url());
      expect(url.searchParams.get("volver")).toBe("/mes");
      expect(url.searchParams.has("todo")).toBe(false);
      // «ver todo» from there still leads back with `volver`.
      expect(await seeAll(page.locator("main")).getAttribute("href")).toBe(habitPath(id, "?volver=/mes&todo=1"));
    } finally {
      await context.close();
    }
  });

  test("folded (no `todo`): «ver todo», no «ver menos»", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» drawn on the folded list.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
    try {
      await expect(seeAll(page.locator("main"))).toHaveCount(1);
      await expect(seeLess(page.locator("main"))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a habit that does not fold draws no «ver menos» in `?todo=1`: 5 months and exactly 12", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» drawn whenever `all` is true.
    for (const months of [5, 12]) {
      const id = await habit20(db, person, months);
      const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
      try {
        expect(rowsOf(between(await mainLower(page), "por mes"))).toHaveLength(months);
        await expect(seeLess(page.locator("main"))).toHaveCount(0);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  test("at 360 «ver menos» fits and the page does not scroll sideways", async ({ person, browser, baseURL, db }) => {
    // Kills: a link wider than the column.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      const links = seeLess(page.locator("main"));
      await expect(links).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const i of [0, 1]) {
        const box = (await links.nth(i).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
      }
    } finally {
      await context.close();
    }
  });
});

test.describe("the order under the label (board VerMenos 3 and 4)", () => {
  test("«Por semana»: the label, then «ver menos», then the first row", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» drawn above the label; the label drawn after the link.
    const id = await noEnd(db, person, "Escribir", 146);
    const { page, context } = await visit(browser, baseURL, person, weekPath(id, "?todo=1"), 360);
    try {
      const label = (await page.locator("main").getByText("por semana", { exact: true }).locator("visible=true").first().boundingBox())!;
      const link = (await seeLess(page.locator("main")).first().boundingBox())!;
      const first = (await weekRows(page).first().boundingBox())!;
      expect(label.y + label.height).toBeLessThanOrEqual(link.y);
      expect(link.y + link.height).toBeLessThanOrEqual(first.y);
      // Tight under the label, as the board draws it: no gap of a whole line.
      expect(link.y - (label.y + label.height)).toBeLessThanOrEqual(16);
    } finally {
      await context.close();
    }
  });

  test("a habit: «Por mes», the count, then «ver menos», then the first month", async ({ person, browser, baseURL, db }) => {
    // Kills: «ver menos» between the label and the count.
    const id = await habit20(db, person, 20);
    const { page, context } = await visit(browser, baseURL, person, habitPath(id, "?todo=1"), 360);
    try {
      const label = (await page.locator("main").getByText("Por mes", { exact: true }).first().boundingBox())!;
      const count = (await page.locator("main").getByText("20 meses", { exact: true }).first().boundingBox())!;
      const link = (await seeLess(page.locator("main")).first().boundingBox())!;
      const first = (await page.getByText(monthLabel(-19), { exact: false }).first().boundingBox())!;
      expect(label.y + label.height).toBeLessThanOrEqual(count.y);
      expect(count.y + count.height).toBeLessThanOrEqual(link.y);
      expect(link.y + link.height).toBeLessThanOrEqual(first.y);
    } finally {
      await context.close();
    }
  });
});
