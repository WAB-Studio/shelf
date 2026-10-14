import { test, expect } from "./fixtures";
import { PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import {
  budget,
  keysFor,
  mainLower,
  monthKey,
  open,
  range,
  reportRow,
  rowMonths,
  sectionOf,
  seeAll,
  yOf,
} from "./mes-siguiente-seed";
import { horizonIn, lineWords, ofRe, seedLeer, seedPiano } from "./por-mes-de-n-seed";

import type { Locator, Page } from "@playwright/test";

// Module 973, RP-120 (the successor of RP-118), board MesesAnteriores faces 1, 2, 3 and 5. A list of months that folds hides closed months:
// it says how many, in one line «12 meses anteriores» BEFORE its table, that opens the same list as «ver todo». Written from the plan's
// Done table and the approved board, never from the screens. Every month is an offset from the day the server reads (PULSAR_CLOCK too).

test.use({ actionTimeout: 6000 });

const EARLIER = /^\d+ mes(es)? anteriores?$/;
const earlier = (scope: Page | Locator, text = EARLIER) => scope.getByRole("link", { name: text, includeHidden: true });
const earlierVisible = (scope: Page | Locator, text: RegExp | string) =>
  scope.getByRole("link", { name: text, exact: typeof text === "string" }).locator("visible=true");
const textOfSection = async (section: Locator) => (await section.innerText()).replace(/\s+/g, " ").toLowerCase();

// A1: «Leer» with an end 3 months on: 27 months, 13 drawn, 2 left out, so 12 closed months hidden.
// A4: no end, 40 a month, December at 60: 14 months, 12 closed hidden.
const seedA4 = async (db: Parameters<typeof budget>[0], person: Parameters<typeof budget>[1], opened?: number) => {
  const id = await seedLeer(db, person, { endsIn: null, opened });
  await budget(db, person, id, 2, 60);
  return id;
};
// A2 / A3 (report): an end 9 months on and December at 60: 33 months, 14 drawn, 7 left out, 12 closed hidden.
const seedA2 = async (db: Parameters<typeof budget>[0], person: Parameters<typeof budget>[1]) => {
  const id = await seedLeer(db, person, { endsIn: 9 });
  await budget(db, person, id, 2, 60);
  return id;
};

for (const width of [360, 1280]) {
  test.describe(`RP-120 «Por mes» at ${width}`, () => {
    test("A1: a goal with an end says «12 meses anteriores» under its «13 de 27 meses» and above its first row, a link to `?todo=1`", async ({ person, browser, baseURL, db }) => {
      // Kills: not drawing the line (676b4961); drawing it after the table.
      const id = await seedLeer(db, person, { endsIn: 3 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        const line = earlierVisible(main, "12 meses anteriores");
        await expect(line).toHaveCount(1);
        expect(await line.getAttribute("href")).toBe(`/metas/${id}/meses?todo=1`);
        expect(await mainLower(page)).toMatch(ofRe(13, 27));
        const first = await yOf(page.locator(`main a[href="/metas/${id}/meses/${monthKey(-11)}"]:visible`));
        const mine = await yOf(line);
        expect(mine.bottom, "the line sits above the first row").toBeLessThanOrEqual(first.top + 1);
        const rest = await yOf(main.getByText(lineWords(2, 3)).locator("visible=true"));
        expect(mine.bottom, "the line is above «2 meses más»").toBeLessThanOrEqual(rest.top);
      } finally {
        await context.close();
      }
    });

    test("the figure is the closed months the fold hides: 27 − 13 − 2, never the months left or the months drawn", async ({ person, browser, baseURL, db }) => {
      // Kills: counting `cut.rest.count` (2) or `settled.length − shown` without the months ahead (14).
      const id = await seedLeer(db, person, { endsIn: 3 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const names = await earlier(page.locator("main")).locator("visible=true").allInnerTexts();
        expect(names.map((name) => name.trim())).toEqual(["12 meses anteriores"]);
      } finally {
        await context.close();
      }
    });

    test("A4: a goal with no end says «14 meses» and «12 meses anteriores», no «de»", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing the line only for a goal with an end.
      const id = await seedA4(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const line = earlierVisible(page.locator("main"), "12 meses anteriores");
        await expect(line).toHaveCount(1);
        expect(await line.getAttribute("href")).toBe(`/metas/${id}/meses?todo=1`);
        const lower = await mainLower(page);
        expect(lower).toMatch(/(?<!\d)14 meses(?! más)/);
        expect(lower).not.toMatch(/\d+ de \d+ meses/);
        const first = await yOf(page.locator(`main a[href="/metas/${id}/meses/${monthKey(-11)}"]:visible`));
        expect((await yOf(line)).bottom).toBeLessThanOrEqual(first.top + 1);
      } finally {
        await context.close();
      }
    });

    test("the line opens the same list as «ver todo» and keeps `volver` as «ver todo» does", async ({ person, browser, baseURL, db }) => {
      // Kills: an href that loses `keep` (the query the page came with).
      const id = await seedLeer(db, person, { endsIn: 3 });
      const volver = encodeURIComponent("/mes");
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?volver=${volver}`, width);
      try {
        const main = page.locator("main");
        const line = (await earlier(main).first().getAttribute("href")) ?? "";
        const all = (await seeAll(main).first().getAttribute("href")) ?? "";
        expect(line).toContain(`volver=${volver}`);
        expect(line).toContain("todo=1");
        expect(line).toBe(all);
        await earlierVisible(main, "12 meses anteriores").click();
        await expect(page).toHaveURL(/todo=1/);
        expect(await rowMonths(page, id)).toContain(monthKey(-23));
      } finally {
        await context.close();
      }
    });

    test("singular: one hidden closed month reads «1 mes anterior»", async ({ person, browser, baseURL, db }) => {
      // Kills: a fixed plural («1 meses anteriores»).
      const id = await seedA4(db, person, -12);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(earlierVisible(page.locator("main"), "1 mes anterior")).toHaveCount(1);
        await expect(earlier(page.locator("main"), /meses anteriores/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("A3: nothing hidden draws no line (Piano: 2 de 120 meses, nothing closed behind)", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing the line with `hidden = 0`.
      const id = await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(seeAll(page.locator("main")).first()).toBeVisible();
        await expect(earlier(page.locator("main"), /anteriores?/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a goal whose whole span is drawn draws no line", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing the line without a fold.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: horizonIn(2), rhythm: 40, created: openedOnDay(1).at });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(page.locator("main a[href*='/meses/']").first()).toBeVisible();
        await expect(earlier(page.locator("main"), /anteriores?/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("A1 with `?todo=1`: «27 meses», «ver menos», no line", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing the line over the whole list.
      const id = await seedLeer(db, person, { endsIn: 3 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        const main = page.locator("main");
        expect(await mainLower(page)).toMatch(/(?<!\d)(?<!de )27 meses(?! más)/);
        await expect(main.getByRole("link", { name: "ver menos", exact: true }).first()).toBeVisible();
        await expect(earlier(main, /anteriores?/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("a month open outside the last 12 opens the whole list at 1280, with no line", async ({ person, browser, baseURL, db }) => {
  // Kills: building the line from the folded cut and not from the cut `openOutside` widens.
  const id = await seedLeer(db, person, { endsIn: 3 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses/${monthKey(-20)}`, 1280);
  try {
    await expect.poll(async () => (await rowMonths(page, id)).length).toBeGreaterThan(20);
    expect(await rowMonths(page, id)).toEqual(expect.arrayContaining(keysFor(range(-23, 3))));
    await expect(earlier(page.locator("main"), /anteriores?/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const width of [360, 1280]) {
  test.describe(`RP-120 the report at ${width}`, () => {
    test("A2: the card of «Leer» (33 months) says «12 meses anteriores» after «14 de 33 meses» and before its first table row, a link to `/exportar?todo=1`", async ({ person, browser, baseURL, db }) => {
      // Kills: not drawing it on the report; an href to `/metas/…`; the line after the table.
      await seedA2(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, "Leer");
        const text = await textOfSection(section);
        expect(text).toMatch(ofRe(14, 33));
        const line = earlierVisible(section, "12 meses anteriores");
        await expect(line).toHaveCount(1);
        const href = (await line.getAttribute("href")) ?? "";
        const url = new URL(href, "http://x");
        expect(url.pathname).toBe("/exportar");
        expect(url.searchParams.get("todo")).toBe("1");
        expect(href).toBe((await seeAll(section).first().getAttribute("href")) ?? "");
        const first = await yOf(reportRow(section, -11));
        expect((await yOf(line)).bottom, "the line is above the first row").toBeLessThanOrEqual(first.top + 1);
        const label = await yOf(section.getByText(/^leer · por mes/i).locator("visible=true"));
        expect((await yOf(line)).top, "the line is below the label").toBeGreaterThanOrEqual(label.top);
      } finally {
        await context.close();
      }
    });

    test("the report's figure is 33 − 14 − 7 = 12 closed months, and a goal with no end says it too", async ({ person, browser, baseURL, db }) => {
      // Kills: counting `cut.rest.count` (7) or `settled.length − shown` (19) on the report; drawing it only with an end.
      await seedA2(db, person);
      const free = await seedA4(db, person);
      expect(free).toBeTruthy();
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        const lines = await earlier(page.locator("main"), EARLIER).locator("visible=true").allInnerTexts();
        expect(lines.map((line) => line.trim())).toEqual(["12 meses anteriores", "12 meses anteriores"]);
      } finally {
        await context.close();
      }
    });

    test("nothing hidden, or `?todo=1`: the report draws no line", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing it with `hidden = 0`; drawing it with `all`.
      await seedPiano(db, person);
      const a = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(a.page.getByRole("main").getByText("Piano", { exact: true }).first()).toBeVisible();
        await expect(earlier(a.page.locator("main"), /anteriores?/)).toHaveCount(0);
      } finally {
        await a.context.close();
      }
      await seedA2(db, person);
      const b = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(b.page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        await expect(earlier(b.page.locator("main"), /anteriores?/)).toHaveCount(0);
      } finally {
        await b.context.close();
      }
    });

    test("360 has no horizontal overflow on the page with the line", async ({ person, browser, baseURL, db }) => {
      // Kills: a line that widens the page (a class outside `components/ui`).
      const id = await seedA2(db, person);
      for (const path of [`/metas/${id}/meses`, "/exportar"]) {
        const { page, context } = await open(browser, baseURL, person.sessionFile, path, width);
        try {
          await expect(earlierVisible(page.locator("main"), "12 meses anteriores")).toHaveCount(1);
          const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          expect(scroll, `${path} at ${width}`).toBeLessThanOrEqual(client);
        } finally {
          await context.close();
        }
      }
    });
  });
}

test("the screen does not change: on the report at 1280 «HASTA HOY» still stacks under «ESTE MES», on one column", async ({ person, browser, baseURL, db }) => {
  // Kills: the paper's new figures block changing the grid on screen.
  await seedA2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", 1280);
  try {
    await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
    const month = await yOf(page.getByRole("main").getByText(/^este mes/i).locator("visible=true").last());
    const today = await yOf(page.getByRole("main").getByText(/^hasta hoy/i).locator("visible=true").last());
    expect(today.top, "«HASTA HOY» under «ESTE MES», as before").toBeGreaterThan(month.bottom);
    const [a, b] = await Promise.all(
      [/^este mes/i, /^hasta hoy/i].map((re) => page.getByRole("main").getByText(re).locator("visible=true").last().boundingBox()),
    );
    expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});
