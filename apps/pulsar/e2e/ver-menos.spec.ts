import { test, expect } from "./fixtures";
import { PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { keysFor, mainLower, monthKey, open, range, rowLink, rowMonths, sectionOf, seeAll, yOf } from "./mes-siguiente-seed";
import { aloneRe, horizonIn, seedPiano, seedTerminada } from "./por-mes-de-n-seed";

import type { Locator, Page } from "@playwright/test";

// Module 965, RP-118, board VerMenos (decision Q3): a list of «Por mes» or of the report that folds and is opened whole (`?todo=1`)
// draws a «ver menos» link before its first table and another where «ver todo» was; it opens the same screen without `todo=1`, keeping
// `volver` and `planear`. Never on paper. A list that does not fold draws none. Example N1 of plan s7. Contract: plan s7 `## 965`.

test.use({ actionTimeout: 6000 });

const seeLess = (scope: Page | Locator) => scope.getByRole("link", { name: "ver menos", exact: true }).locator("visible=true");

for (const width of [360, 1280]) {
  test.describe(`«ver menos» in «Por mes» at ${width}`, () => {
    test("N1 `?todo=1`: 120 rows, «120 meses», one «ver menos» above the table and one under its last row, both to `/metas/{id}/meses`", async ({ person, browser, baseURL, db }) => {
      // Kills: the `href` keeping `todo=1`; only one of the two links; the first link under the table; the second above it.
      const id = await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        const main = page.locator("main");
        await expect(rowLink(page, id, 0).first()).toBeVisible();
        expect(await rowMonths(page, id)).toEqual(keysFor(range(0, 119)));
        expect(await mainLower(page)).toMatch(aloneRe(120));
        const links = seeLess(main);
        await expect(links).toHaveCount(2);
        for (const index of [0, 1]) expect(await links.nth(index).getAttribute("href"), `link ${index}`).toBe(`/metas/${id}/meses`);
        const [first, firstRow, lastRow, last] = [
          await yOf(links.nth(0)),
          await yOf(rowLink(page, id, 0)),
          await yOf(rowLink(page, id, 119)),
          await yOf(links.nth(1)),
        ];
        expect(first.bottom, "the first link above the first row").toBeLessThanOrEqual(firstRow.top + 1);
        expect(last.top, "the second link under the last row").toBeGreaterThanOrEqual(lastRow.bottom - 1);
        await expect(seeAll(main)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("`?todo=1` keeps `volver` and `planear` in «ver menos» and drops `todo`", async ({ person, browser, baseURL, db }) => {
      // Kills: losing `keep` (volver, planear) when it builds the link.
      const id = await seedPiano(db, person);
      const query = `planear=${monthKey(1)}&volver=${encodeURIComponent("/mes")}&todo=1`;
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?${query}`, width);
      try {
        await expect(rowLink(page, id, 0).first()).toBeVisible();
        // The amount sheet opened by `planear` marks the rest `aria-hidden`: the links stay behind it, drawn; the other face's copy is `display: none` and stays out.
        const links = page.locator("main").getByRole("link", { name: "ver menos", exact: true, includeHidden: true }).locator("visible=true");
        await expect(links).toHaveCount(2);
        for (const index of [0, 1]) {
          const href = (await links.nth(index).getAttribute("href")) ?? "";
          expect(href, `link ${index}`).toMatch(/volver=(%2F|\/)mes(&|$)/);
          expect(href, `link ${index}`).toContain(`planear=${monthKey(1)}`);
          expect(href, `link ${index}`).not.toContain("todo");
          expect(href.startsWith(`/metas/${id}/meses?`), `link ${index}`).toBe(true);
        }
      } finally {
        await context.close();
      }
    });

    test("touching «ver menos» opens the folded list again: «2 de 120 meses», «ver todo»", async ({ person, browser, baseURL, db }) => {
      // Kills: a «ver menos» that leads anywhere but the same screen without `todo=1`.
      const id = await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        await seeLess(page.locator("main")).first().click();
        await expect(page).not.toHaveURL(/todo=/);
        await expect(seeAll(page.locator("main"))).toBeVisible();
        expect(await rowMonths(page, id)).toEqual(keysFor([0, 1]));
        await expect(seeLess(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("an ended goal of 20 months, a list that folds, draws «ver menos» twice with `?todo=1` and none folded", async ({ person, browser, baseURL, db }) => {
      // Kills: «ver menos» only for goals with an end that is open; none on the ended goal's whole list.
      const { id, last } = await seedTerminada(db, person);
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        await expect(rowLink(a.page, id, last).first()).toBeVisible();
        await expect(seeLess(a.page.locator("main"))).toHaveCount(2);
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(seeAll(b.page.locator("main"))).toBeVisible();
        await expect(seeLess(b.page.locator("main"))).toHaveCount(0);
      } finally {
        await b.context.close();
      }
    });

    test("C2: a goal of 3 months does not fold, so `?todo=1` draws no «ver menos» and no «ver todo»", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing «ver menos» whenever `all` is set.
      const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: PAGES, horizon: horizonIn(2), rhythm: 40, created: openedOnDay(1).at });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        await expect(rowLink(page, id, 0).first()).toBeVisible();
        expect(await rowMonths(page, id)).toEqual(keysFor([0, 1, 2]));
        await expect(seeLess(page.locator("main"))).toHaveCount(0);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });

  test.describe(`«ver menos» in the report at ${width}`, () => {
    test("`/exportar?todo=1` of N1: two «ver menos» in Piano's section, both to `/exportar` with no `todo`; the folded report draws none", async ({ person, browser, baseURL, db }) => {
      // Kills: the report's «ver menos» keeping `todo=1`; drawing it on the folded report.
      await seedPiano(db, person);
      const a = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(a.page.getByRole("main").getByText("Piano", { exact: true }).first()).toBeVisible();
        const section = sectionOf(a.page, "Piano");
        const links = seeLess(section);
        await expect(links).toHaveCount(2);
        for (const index of [0, 1]) {
          const href = (await links.nth(index).getAttribute("href")) ?? "";
          const url = new URL(href, "http://x");
          expect(url.pathname, `link ${index}`).toBe("/exportar");
          expect(url.searchParams.has("todo"), `link ${index}`).toBe(false);
        }
        await expect(seeAll(section)).toHaveCount(0);
        await links.first().click();
        await expect(a.page).not.toHaveURL(/todo=/);
        await expect(seeAll(sectionOf(a.page, "Piano"))).toBeVisible();
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(b.page.getByRole("main").getByText("Piano", { exact: true }).first()).toBeVisible();
        await expect(seeLess(b.page.locator("main"))).toHaveCount(0);
      } finally {
        await b.context.close();
      }
    });

    test("`/exportar?todo=1` of a goal of 3 months draws no «ver menos»", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing «ver menos» on every goal under `?todo=1`.
      await seedOpenGoal(db, person, { name: "Correr 10 km", unit: PAGES, horizon: horizonIn(2), rhythm: 40, created: openedOnDay(1).at });
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(page.getByRole("main").getByText("Correr 10 km", { exact: true }).first()).toBeVisible();
        await expect(seeLess(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("at 360 «Por mes» `?todo=1` fits with its two «ver menos»", async ({ person, browser, baseURL, db }) => {
  // Kills: a link wider than the column.
  const id = await seedPiano(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, 360);
  try {
    const links = seeLess(page.locator("main"));
    await expect(links).toHaveCount(2);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
    for (const index of [0, 1]) {
      const box = await links.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    }
  } finally {
    await context.close();
  }
});
