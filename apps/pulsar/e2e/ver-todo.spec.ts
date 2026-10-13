import type { Browser, Locator, Page } from "@playwright/test";

import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";
import { monthsAhead } from "./meta-arbol-seed";
import { PAGES, seedOpenGoal } from "./metas-sin-final-seed";
import { MONTH_START, monthLabel, monthStartOf, seedGoal, seedTap, shift } from "./sin-final-seed";

// Module 925, RP-106: the lists that grow with no end show their last 12 rows and «ver todo». Por semana: the last 12
// weeks, the current one last. Por mes and the report: this month and the eleven after. `?todo=1` opens the whole list;
// a goal with an end, or a list of 12 rows or fewer, has no link; there is no «ver menos».
// Boards: VerTodoListas (private/tableros-s2/NOTAS.md §2). Every date is relative to today. Each test names its mutation.

test.use({ actionTimeout: 6000 });

const SEE_ALL = "ver todo";
const seeAll = (scope: Page | Locator) => scope.getByRole("link", { name: SEE_ALL, exact: true });

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width: number) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

// A table draws each row twice (stack and wide); only the visible one counts.
const weekRows = (page: Page) => page.locator("main ol > li:visible, main tbody tr:visible");

async function monthHrefs(page: Page, id: string): Promise<string[]> {
  return page.locator(`main a[href^="/metas/${id}/meses/"]`).evaluateAll((links) =>
    [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))].filter((href) => /\/meses\/\d{4}-\d{2}$/.test(href)),
  );
}

const monthHref = (id: string, offset: number) => `/metas/${id}/meses/${monthStartOf(offset).slice(0, 7)}`;

// The week number of today for a goal opened on a Monday: counted from that Monday.
function weekNumberOf(openedMonday: string): number {
  const days = Math.round((civilDateToDate(weekOf(todayInZone())[0]).getTime() - civilDateToDate(openedMonday).getTime()) / 86_400_000);
  return days / 7 + 1;
}

const OPENED_MONDAY = "2024-01-01";
const openedMonthsAgo = (months: number) => new Date(`${monthStartOf(-months).slice(0, 8)}01T12:00:00Z`);

async function noOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  const box = await seeAll(page.locator("main")).first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
}

// ---- Por semana ------------------------------------------------------------------------------------------------

for (const width of [360, 1280]) {
  test.describe(`at ${width}`, () => {
    test("«Por semana» of a goal with no end opened long ago shows its last 12 weeks, the current one last, and «ver todo» (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: no cut (every week since 2024 drawn); the cut taking the first 12 weeks; the current week not last.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, created: new Date(`${OPENED_MONDAY}T12:00:00Z`) });
      const n = weekNumberOf(OPENED_MONDAY);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/revision`, width);
      try {
        await expect(seeAll(page.locator("main"))).toBeVisible();
        const rows = weekRows(page);
        await expect(rows).toHaveCount(12);
        // The row's textContent glues «semana 135» to its dates; innerText keeps the line between them.
        await expect(rows.first()).toContainText(new RegExp(`semana ${n - 11}\\b`, "i"), { useInnerText: true });
        await expect(rows.last()).toContainText(new RegExp(`semana ${n}\\b`, "i"), { useInnerText: true });
        await expect(rows.last()).toContainText("en curso");
        expect(await rows.evaluateAll((all) => all.filter((row) => /semana 1\b/i.test((row as HTMLElement).innerText)).length)).toBe(0);
      } finally {
        await context.close();
      }
    });

    test("«ver todo» on «Por semana» opens every week from week 1 and leaves no link behind (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: the link not carrying `?todo=1`; the full list still cut; a «ver menos» (or the link) left on the full list.
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, created: new Date(`${OPENED_MONDAY}T12:00:00Z`) });
      const n = weekNumberOf(OPENED_MONDAY);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/revision`, width);
      try {
        await seeAll(page.locator("main")).click();
        await expect(page).toHaveURL(/todo=1/);
        const rows = weekRows(page);
        await expect(rows).toHaveCount(n);
        await expect(rows.first()).toContainText(/semana 1\b/i, { useInnerText: true });
        await expect(rows.last()).toContainText("en curso");
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
        await expect(page.getByRole("link", { name: /ver menos/i })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«Por semana» of a goal with no end and 5 weeks lists 5 rows and no link (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: showing the link for any no-end goal; padding the list to 12.
      const monday = shift(weekOf(todayInZone())[0], -28);
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, created: new Date(`${monday}T12:00:00Z`) });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/revision`, width);
      try {
        await expect(weekRows(page)).toHaveCount(5);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«Por semana» of a goal with 12 weeks has no link; one more week brings it (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: `>= 12` where `> 12` is meant, and `> 13`: the line between 12 rows and 13.
      const twelve = await seedOpenGoal(db, person, { name: "Doce", unit: PAGES, horizon: null, created: new Date(`${shift(weekOf(todayInZone())[0], -77)}T12:00:00Z`) });
      const thirteen = await seedOpenGoal(db, person, { name: "Trece", unit: PAGES, horizon: null, created: new Date(`${shift(weekOf(todayInZone())[0], -84)}T12:00:00Z`) });
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${twelve}/revision`, width);
      try {
        await expect(weekRows(a.page)).toHaveCount(12);
        await expect(seeAll(a.page.locator("main"))).toHaveCount(0);
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, `/metas/${thirteen}/revision`, width);
      try {
        await expect(weekRows(b.page)).toHaveCount(12);
        await expect(seeAll(b.page.locator("main"))).toBeVisible();
      } finally {
        await b.context.close();
      }
    });

    test("«Por semana» of a goal with an end lists all 30 weeks and no link (control, RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut applied to a goal with an end.
      const monday = shift(weekOf(todayInZone())[0], -203);
      const id = await seedOpenGoal(db, person, { name: "Inglés B1", unit: PAGES, horizon: shift(monday, 7 * 30), created: new Date(`${monday}T12:00:00Z`) });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/revision`, width);
      try {
        await expect(weekRows(page)).toHaveCount(30);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    // ---- Por mes -----------------------------------------------------------------------------------------------

    test("«Por mes» of a goal with no end opened 30 months ago lists 12 months from this one, says why, and offers «ver todo» (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: listing from the opening (42 rows); dropping the sentence «Sin final…»; no link.
      const id = await seedOpenGoal(db, person, { name: "Cuidado", unit: PAGES, horizon: null, created: openedMonthsAgo(30) });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(page.getByText("Sin final: se ven los 12 meses que vienen.", { exact: true })).toBeVisible();
        await expect(seeAll(page.locator("main"))).toBeVisible();
        const hrefs = await monthHrefs(page, id);
        expect(hrefs).toHaveLength(12);
        expect(hrefs).toContain(monthHref(id, 0));
        expect(hrefs).toContain(monthHref(id, 11));
        expect(hrefs).not.toContain(monthHref(id, -1));
      } finally {
        await context.close();
      }
    });

    test("`?todo=1` on «Por mes» lists the 30 closed months, this one and the 11 after, keeps `planear` and `volver`, and has no link (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: ignoring `todo`; the link dropping `planear` or `volver`; the amount sheet closing when the list opens.
      const id = await seedOpenGoal(db, person, { name: "Cuidado", unit: PAGES, horizon: null, created: openedMonthsAgo(30) });
      const planned = monthsAhead(2).slice(0, 7);
      const volver = `/metas/${id}/meses`;
      const query = `planear=${planned}&volver=${encodeURIComponent(volver)}`;
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?${query}`, width);
      try {
        // The sheet is open: the link behind it is read from the DOM, not clicked.
        const link = page.getByRole("link", { name: SEE_ALL, exact: true, includeHidden: true });
        await expect(link).toHaveCount(1);
        const href = (await link.getAttribute("href")) ?? "";
        expect(href).toContain("todo=1");
        expect(href).toContain(`planear=${planned}`);
        expect(href).toContain(`volver=${encodeURIComponent(volver)}`);
        await page.goto(href);
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.locator("main")).toHaveCount(1);
        const hrefs = await monthHrefs(page, id);
        expect(hrefs).toHaveLength(42);
        expect(hrefs).toContain(monthHref(id, -30));
        expect(hrefs).toContain(monthHref(id, -1));
        expect(hrefs).toContain(monthHref(id, 11));
        await expect(page.getByRole("link", { name: SEE_ALL, exact: true, includeHidden: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: /ver menos/i, includeHidden: true })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«Por mes» with exactly 12 months has no link and with 13 it has (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: the boundary of the cut (`>= 12`, `> 13`); the sentence «Sin final…» lost with the link.
      const exactly = await seedOpenGoal(db, person, { name: "Doce", unit: PAGES, horizon: null, created: openedMonthsAgo(0) });
      const one = await seedOpenGoal(db, person, { name: "Trece", unit: PAGES, horizon: null, created: openedMonthsAgo(1) });
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${exactly}/meses`, width);
      try {
        expect(await monthHrefs(a.page, exactly)).toHaveLength(12);
        await expect(seeAll(a.page.locator("main"))).toHaveCount(0);
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, `/metas/${one}/meses`, width);
      try {
        expect(await monthHrefs(b.page, one)).toHaveLength(12);
        await expect(seeAll(b.page.locator("main"))).toBeVisible();
        expect(await monthHrefs(b.page, one)).not.toContain(monthHref(one, -1));
      } finally {
        await b.context.close();
      }
    });

    test("«Por mes» of a goal with an end lists its months as before and has no link (control, RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut applied to a goal with an end (it opened 30 months ago and ends in 3 months: 34 months).
      const id = await seedOpenGoal(db, person, { name: "Con final", unit: PAGES, horizon: monthsAhead(3), created: openedMonthsAgo(30) });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const hrefs = await monthHrefs(page, id);
        expect(hrefs.length).toBeGreaterThan(12);
        expect(hrefs).toContain(monthHref(id, -30));
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    // ---- The report on screen ----------------------------------------------------------------------------------

    test("the report of a goal with no end opened 80 days ago shows 12 months, none closed, and «ver todo»; `?todo=1` adds the 3 closed (RP-106)", async ({ person, browser, baseURL, db }) => {
      // Kills: the screen not cutting what the loader now hands over; `todo` ignored by the report; the link left on the full list.
      const name = `Leer ${Date.now()}`;
      const goalId = await seedGoal(db, person.id, name, {
        horizon: null,
        unit: "páginas",
        budget: 34,
        created: new Date(`${shift(MONTH_START, -80)}T12:00:00Z`),
      });
      await seedTap(db, person.id, goalId, `Leer diez ${name}`);
      const section = (page: Page) => page.locator("section").filter({ has: page.getByText(`${name} · por mes`, { exact: true }) });
      const row = (page: Page, offset: number) =>
        section(page).locator("li:visible, tbody tr:visible").filter({ hasText: new RegExp(monthLabel(offset), "i") });
      const first = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(first.page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        await expect(seeAll(section(first.page))).toBeVisible();
        for (let offset = 0; offset <= 11; offset++) await expect(row(first.page, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [-1, -2, -3]) await expect(row(first.page, offset), monthLabel(offset)).toHaveCount(0);
        await expect(row(first.page, 12)).toHaveCount(0);
      } finally {
        await first.context.close();
      }
      const all = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(all.page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        for (let offset = -3; offset <= 11; offset++) await expect(row(all.page, offset), monthLabel(offset)).toHaveCount(1);
        await expect(row(all.page, -4)).toHaveCount(0);
        await expect(seeAll(section(all.page))).toHaveCount(0);
      } finally {
        await all.context.close();
      }
    });
  });
}

// ---- 1024: the list beside a closed month -------------------------------------------------------------------------

test("at 1024 a closed month opened beside the list shows the whole list, that month marked, and no link (RP-106)", async ({ person, browser, baseURL, db }) => {
  // Kills: the 12-row cut hiding the month that is open; marking nothing; offering «ver todo» when everything is shown.
  const id = await seedOpenGoal(db, person, { name: "Cuidado", unit: PAGES, horizon: null, created: openedMonthsAgo(30) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, monthHref(id, -5), 1024);
  try {
    const hrefs = await monthHrefs(page, id);
    expect(hrefs).toHaveLength(42);
    expect(hrefs).toContain(monthHref(id, -5));
    const marked = await page.locator(`main a[aria-current="page"][href^="/metas/${id}/meses/"]`).evaluateAll((links) =>
      [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href")))],
    );
    expect(marked).toEqual([monthHref(id, -5)]);
    await expect(seeAll(page.locator("main"))).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("at 1024 the current month beside the list keeps the 12-row cut and the link (RP-106)", async ({ person, browser, baseURL, db }) => {
  // Kills: showing everything whenever a month is open (the closed-month rule applied to every month).
  const id = await seedOpenGoal(db, person, { name: "Cuidado", unit: PAGES, horizon: null, created: openedMonthsAgo(30) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, monthHref(id, 0), 1024);
  try {
    expect(await monthHrefs(page, id)).toHaveLength(12);
    await expect(seeAll(page.locator("main"))).toBeVisible();
  } finally {
    await context.close();
  }
});

// ---- 360: nothing overflows -----------------------------------------------------------------------------------------

test("at 360 «ver todo» fits on «Por semana», «Por mes» and the report (RP-106)", async ({ person, browser, baseURL, db }) => {
  // Kills: a link wider than the column or a row pushed out by it, on any of the three lists.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: null, created: new Date(`${OPENED_MONDAY}T12:00:00Z`) });
  const name = `Informe ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, name, {
    horizon: null,
    unit: "páginas",
    budget: 34,
    created: new Date(`${shift(MONTH_START, -80)}T12:00:00Z`),
  });
  await seedTap(db, person.id, goalId, `Leer diez ${name}`);
  for (const path of [`/metas/${id}/revision`, `/metas/${id}/meses`, "/exportar"]) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      await expect(seeAll(page.locator("main")).first()).toBeVisible();
      await noOverflow(page);
    } finally {
      await context.close();
    }
  }
});
