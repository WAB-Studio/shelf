import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser, Locator, Page } from "@playwright/test";

import { test, expect, visit, type Person } from "./fixtures";
import { PAGES, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf } from "./sin-final-seed";

import type postgres from "postgres";

// Module 932, RP-107: a goal with no end shows its last 11 closed months and the current one in «Por mes», in the
// report and on paper. A month ahead with an amount set by hand follows them as a row; the rest ahead fold into one
// line, «los meses que vienen: 40 páginas cada uno», which opens the whole list (`?todo=1`). A goal with no rhythm
// draws no line, and on screen no month ahead with nothing planned. Paper never opens «ver todo» and folds the
// empty months ahead into the line a goal with an end prints. Boards: PorMesUltimos, InformeUltimos
// (private/tableros-s3/NOTAS.md §1–2; docs/pulsar/DESIGN.md wins where the two differ).
// Every month is an offset from the real current month. Each test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

type Db = postgres.Sql;

const SEE_ALL = "ver todo";
const seeAll = (scope: Page | Locator) => scope.getByRole("link", { name: SEE_ALL, exact: true });
const LINE = /los meses que vienen: 40 páginas cada uno/i;
const lineOf = (scope: Page | Locator) => scope.getByRole("link", { name: LINE });
const ANY_LINE = /los meses que vienen/i;
const NO_END = "Sin final: se ven los 12 meses que vienen.";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const monthHref = (id: string, offset: number) => `/metas/${id}/meses/${monthStartOf(offset).slice(0, 7)}`;
// The day 5 of a month `offset` from this one, as E1 opens («abierta el 5 nov 2024»).
const openedIn = (offset: number) => new Date(`${monthStartOf(offset).slice(0, 8)}05T12:00:00Z`);

const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
// How the line paper prints for a goal with an end names a month: «noviembre de 2026».
const longMonth = (offset: number) => `${NAMES[Number(monthStartOf(offset).slice(5, 7)) - 1]} de ${monthStartOf(offset).slice(0, 4)}`;

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width: number) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

async function monthHrefs(page: Page, id: string): Promise<string[]> {
  return page.locator(`main a[href^="/metas/${id}/meses/"]`).evaluateAll((links) =>
    [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""))].filter((href) => /\/meses\/\d{4}-\d{2}$/.test(href)),
  );
}
const hrefsFor = (id: string, offsets: number[]) => offsets.map((offset) => monthHref(id, offset)).sort();

// A month's amount set by hand, as «Planear» writes it.
async function budget(db: Db, person: Person, goalId: string, offset: number, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${monthStartOf(offset)}::date, ${amount})`;
}

// E1: «Leer», no end, opened the 5th of a month 23 months back (24 months up to this one), pages, 40 a month.
async function seedLeer(db: Db, person: Person, opts: { rhythm?: number | null; opened?: number; name?: string } = {}) {
  return seedOpenGoal(db, person, {
    name: opts.name ?? "Leer",
    unit: PAGES,
    horizon: null,
    rhythm: opts.rhythm === undefined ? 40 : opts.rhythm,
    created: openedIn(opts.opened ?? -23),
  });
}

const mainLower = async (page: Page) => (await page.locator("main").innerText()).toLowerCase();

async function yOf(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return { top: box!.y, bottom: box!.y + box!.height };
}

for (const width of [360, 1280]) {
  test.describe(`«Por mes» at ${width}`, () => {
    test("E1 lists the last 11 closed months and the current one, and nothing ahead (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut taking the whole span (current + 11 ahead, s2); the cut taking the first 12; no «en curso».
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, range(-11, 0)));
        expect(await mainLower(page)).toContain("12 meses");
        const first = page.locator(`main a[href="${monthHref(id, -11)}"]:visible`).first();
        await expect(first).toContainText(new RegExp(monthLabel(-11), "i"));
        const current = page.locator(`main a[href="${monthHref(id, 0)}"]:visible`).first();
        await expect(current).toContainText("en curso");
      } finally {
        await context.close();
      }
    });

    test("E1 folds the months ahead into «los meses que vienen: 40 páginas cada uno», under the table, with «ver todo» below it (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing the folded months as rows; the line missing or above the last row; the unit dropped from the line.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const line = lineOf(page.locator("main"));
        await expect(line).toBeVisible();
        expect(await monthHrefs(page, id)).not.toContain(monthHref(id, 1));
        const last = await yOf(page.locator(`main a[href="${monthHref(id, 0)}"]:visible`).first());
        const folded = await yOf(line);
        expect(folded.top).toBeGreaterThanOrEqual(last.bottom - 1);
        const all = await yOf(seeAll(page.locator("main")));
        expect(all.top).toBeGreaterThanOrEqual(folded.bottom - 1);
      } finally {
        await context.close();
      }
    });

    test("touching the line opens `?todo=1` and keeps `planear` and `volver` (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: a line with no link; the link losing the query the amount sheet needs.
      const id = await seedLeer(db, person);
      const planned = monthStartOf(2).slice(0, 7);
      const volver = `/metas/${id}/meses`;
      const { page, context } = await open(
        browser,
        baseURL,
        person.sessionFile,
        `/metas/${id}/meses?planear=${planned}&volver=${encodeURIComponent(volver)}`,
        width,
      );
      try {
        // The amount sheet is open over the list: the links behind it are read from the DOM.
        const href = (await page.getByRole("link", { name: LINE, includeHidden: true }).getAttribute("href")) ?? "";
        expect(href).toContain("todo=1");
        expect(href).toContain(`planear=${planned}`);
        expect(href).toContain(`volver=${encodeURIComponent(volver)}`);
      } finally {
        await context.close();
      }
    });

    test("the line itself, touched, lists every month (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: the line pointing anywhere but `?todo=1`.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await lineOf(page.locator("main")).click();
        await expect(page).toHaveURL(/todo=1/);
        expect((await monthHrefs(page, id)).length).toBe(35);
      } finally {
        await context.close();
      }
    });

    test("a month ahead with 60 pages set by hand is a row between this month and the line, and the line stays at 40 (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: folding every month ahead; the hand-set amount replacing the rhythm in the line.
      const id = await seedLeer(db, person);
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, [...range(-11, 0), 2]));
        const row = page.locator(`main a[href="${monthHref(id, 2)}"]:visible`).first();
        await expect(row).toContainText(new RegExp(monthLabel(2), "i"));
        await expect(row).toContainText("60");
        const current = await yOf(page.locator(`main a[href="${monthHref(id, 0)}"]:visible`).first());
        const mine = await yOf(row);
        const folded = await yOf(lineOf(page.locator("main")));
        expect(mine.top).toBeGreaterThanOrEqual(current.bottom - 1);
        expect(folded.top).toBeGreaterThanOrEqual(mine.bottom - 1);
        expect(await mainLower(page)).toContain("13 meses");
      } finally {
        await context.close();
      }
    });

    test("«ver todo» opens the 24 months up to this one and the 11 ahead, without the line, keeping `planear` (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: `?todo=1` without the months ahead; `keep` lost; the line or «ver todo» left on the full list.
      const id = await seedLeer(db, person);
      const planned = monthStartOf(3).slice(0, 7);
      const volver = `/metas/${id}/meses`;
      const query = `planear=${planned}&volver=${encodeURIComponent(volver)}`;
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?${query}`, width);
      try {
        const link = page.getByRole("link", { name: SEE_ALL, exact: true, includeHidden: true });
        await expect(link).toHaveCount(1);
        const href = (await link.getAttribute("href")) ?? "";
        expect(href).toContain("todo=1");
        expect(href).toContain(`planear=${planned}`);
        await page.goto(href);
        await expect(page.getByRole("dialog")).toBeVisible();
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, range(-23, 11)));
        await expect(page.getByRole("link", { name: ANY_LINE, includeHidden: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: SEE_ALL, exact: true, includeHidden: true })).toHaveCount(0);
        await expect(page.getByText(/ver menos/i)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("«ver todo» starts at the opening month, which counts only its part («de 34») (E1)", async ({ person, browser, baseURL, db }) => {
      // Kills: `?todo=1` starting after the opening month; the first month counted whole.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        const first = page.locator(`main a[href="${monthHref(id, -23)}"]:visible`).first();
        await expect(first).toContainText(new RegExp(monthLabel(-23), "i"));
        await expect(first).toContainText("de 34");
      } finally {
        await context.close();
      }
    });

    for (const query of ["", "?todo=1"]) {
      test(`the Hollow sentence «Sin final: se ven los 12 meses que vienen.» is gone (/meses${query})`, async ({ person, browser, baseURL, db }) => {
        // Kills: `month.months.noEnd` left in the list, shown or not under `?todo=1`.
        const id = await seedLeer(db, person);
        const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses${query}`, width);
        try {
          await expect(page.locator(`main a[href="${monthHref(id, 0)}"]:visible`).first()).toBeVisible();
          await expect(page.getByText(NO_END, { exact: true })).toHaveCount(0);
          expect(await mainLower(page)).not.toContain("sin final");
        } finally {
          await context.close();
        }
      });
    }

    test("a goal opened 2 months ago lists 3 rows and the line, with no «ver todo» (E1)", async ({ person, browser, baseURL, db }) => {
      // Kills: «ver todo» drawn when nothing is hidden; the line dropped when the list is short.
      const id = await seedLeer(db, person, { opened: -2 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, [-2, -1, 0]));
        await expect(lineOf(page.locator("main"))).toBeVisible();
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
        expect(await mainLower(page)).toContain("3 meses");
      } finally {
        await context.close();
      }
    });

    test("with no rhythm: the 12 months and, ahead, only the month set by hand; no line, no empty month (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: drawing `empty` months ahead; a line for a goal with no rhythm.
      const id = await seedLeer(db, person, { rhythm: null });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, [...range(-11, 0), 2]));
        await expect(page.getByRole("link", { name: ANY_LINE, includeHidden: true })).toHaveCount(0);
        expect(await mainLower(page)).not.toContain("los meses que vienen");
        await expect(seeAll(page.locator("main"))).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("with no rhythm and nothing set by hand, no month ahead and no line (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: a line «sin monto» (the rejected board); empty months drawn as rows.
      const id = await seedLeer(db, person, { rhythm: null });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, range(-11, 0)));
        expect(await mainLower(page)).not.toContain("los meses que vienen");
      } finally {
        await context.close();
      }
    });

    test("a goal with an end of 30 months lists all 30, with no line and no link (control, RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut applied to a goal with an end.
      const id = await seedOpenGoal(db, person, {
        name: "Con final",
        unit: PAGES,
        horizon: monthStartOf(30),
        rhythm: 40,
        created: openedIn(0) > new Date() ? new Date() : openedIn(0),
      });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect((await monthHrefs(page, id)).length).toBe(30);
        await expect(page.getByRole("link", { name: ANY_LINE, includeHidden: true })).toHaveCount(0);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a group with no end lists its closed months and the months ahead its goals set by hand, with no line of its own (RP-80, RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: folding the group's months ahead into a rhythm line it does not have; dropping its closed months.
      const group = await seedOpenGoal(db, person, { name: "Grupo", horizon: null, created: openedIn(-2) });
      const child = await seedOpenGoal(db, person, { name: "Hijo", parent: group, unit: PAGES, horizon: null, rhythm: null, created: openedIn(-2) });
      await budget(db, person, child, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${group}/meses`, width);
      try {
        const hrefs = (await monthHrefs(page, group)).sort();
        for (const offset of [-2, -1, 0, 2]) expect(hrefs, monthLabel(offset)).toContain(monthHref(group, offset));
        expect(hrefs).not.toContain(monthHref(group, 1));
        expect(hrefs).not.toContain(monthHref(group, 3));
        await expect(page.getByRole("link", { name: ANY_LINE, includeHidden: true })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("at 1024 a closed month beside the list shows the whole list, that month marked, no line and no link (RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: the 12-row cut hiding the month that is open; marking nothing; the line left on the whole list.
  const id = await seedLeer(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, monthHref(id, -23), 1024);
  try {
    expect((await monthHrefs(page, id)).sort()).toEqual(hrefsFor(id, range(-23, 11)));
    const marked = await page.locator(`main a[aria-current="page"][href^="/metas/${id}/meses/"]`).evaluateAll((links) =>
      [...new Set(links.map((a) => (a as HTMLAnchorElement).getAttribute("href")))],
    );
    expect(marked).toEqual([monthHref(id, -23)]);
    await expect(seeAll(page.locator("main"))).toHaveCount(0);
    await expect(page.getByRole("link", { name: ANY_LINE, includeHidden: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("at 360 the line and «ver todo» fit in «Por mes» and in the report (RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: a line wider than the column or pushing a row out.
  const id = await seedLeer(db, person, { name: "Leer largo para medir el ancho de la línea" });
  for (const path of [`/metas/${id}/meses`, "/exportar"]) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      const line = lineOf(page.locator("main")).first();
      await expect(line).toBeVisible();
      await expect(seeAll(page.locator("main")).first()).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, path).toBeLessThanOrEqual(0);
      for (const box of [await line.boundingBox(), await seeAll(page.locator("main")).first().boundingBox()]) {
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      }
    } finally {
      await context.close();
    }
  }
});

// ---- The report on screen -----------------------------------------------------------------------------------------

const sectionOf = (page: Page, name: string) =>
  page.locator("section").filter({ has: page.getByText(`${name} · por mes`, { exact: true }) });
const rowOf = (section: Locator, offset: number) =>
  section.locator("li:visible, tbody tr:visible").filter({ hasText: new RegExp(monthLabel(offset), "i") });

for (const width of [360, 1280]) {
  test.describe(`the report at ${width}`, () => {
    test("E1 lists 12 months, the line and «ver todo», with nothing ahead (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: `tailOf(goal.months)` over the whole span (current + 11 ahead); the line or the link missing.
      const name = "Leer";
      await seedLeer(db, person, { name });
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        for (const offset of range(-11, 0)) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [-12, 1, 2]) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(0);
        await expect(section.getByText("12 meses", { exact: true }).locator("visible=true")).toHaveCount(1);
        const line = lineOf(section);
        await expect(line).toBeVisible();
        expect((await line.getAttribute("href")) ?? "").toContain("/exportar?todo=1");
        await expect(seeAll(section)).toBeVisible();
        expect(await section.innerText()).not.toContain(NO_END);
      } finally {
        await context.close();
      }
    });

    test("`?todo=1` opens every month from the opening to the last one ahead, without the line or the link (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: the report ignoring `todo`; `todo` opening the closed months but not those ahead.
      const name = "Leer";
      await seedLeer(db, person, { name });
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        for (const offset of range(-23, 11)) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [-24, 12]) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(0);
        await expect(lineOf(section)).toHaveCount(0);
        await expect(seeAll(section)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a month ahead with 60 pages set by hand is a row on screen and the line stays at 40 (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: ignoring the rhythm of 930 (every month ahead with an amount folded or every one drawn).
      const name = "Leer";
      const id = await seedLeer(db, person, { name });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        await expect(rowOf(section, 2)).toHaveCount(1);
        await expect(rowOf(section, 2)).toContainText("60");
        await expect(rowOf(section, 1)).toHaveCount(0);
        await expect(rowOf(section, 3)).toHaveCount(0);
        await expect(lineOf(section)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("with no rhythm the report draws the 12 months, the month set by hand and no line (RP-107)", async ({ person, browser, baseURL, db }) => {
      // Kills: a line for a goal with no rhythm; empty months ahead listed on screen.
      const name = "Leer";
      const id = await seedLeer(db, person, { name, rhythm: null });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        for (const offset of [...range(-11, 0), 2]) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [1, 3, 4]) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(0);
        await expect(section.getByRole("link", { name: ANY_LINE })).toHaveCount(0);
        expect((await section.innerText()).toLowerCase()).not.toContain("los meses que vienen");
      } finally {
        await context.close();
      }
    });
  });
}

// ---- Paper --------------------------------------------------------------------------------------------------------

const A4 = { width: 794, height: 1123 };

// One goal's text on paper, from its «por mes» label to the next label (or the end), lowercase, one run.
async function paperOf(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, name: string): Promise<string> {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page = await context.newPage();
    await visit(page, path);
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `ultimos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const flat = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ").toLowerCase();
    const label = `${name} · por mes`.toLowerCase();
    const from = flat.indexOf(label);
    expect(from, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
    const to = flat.indexOf("· por mes", from + label.length);
    return flat.slice(from, to === -1 ? undefined : to);
  } finally {
    await context.close();
  }
}

const LINE_TEXT = "los meses que vienen: 40 páginas cada uno";

for (const query of ["", "?todo=1"]) {
  test(`E1 on paper prints the 12 months and the line, never the months ahead nor «ver todo» (/exportar${query}) (RP-107)`, async ({ person, browser, baseURL, db }) => {
    // Kills: printing `screenMonths` (the whole list under `?todo=1`); the line missing on paper; the link printed.
    await seedLeer(db, person);
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Leer");
    expect(paper).toContain("leer · por mes · 12 meses");
    for (const offset of range(-11, 0)) expect(paper, monthLabel(offset)).toContain(monthLabel(offset));
    for (const offset of [-12, 1, 2]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
    expect(paper).toContain(LINE_TEXT);
    expect(paper).not.toContain("ver todo");
    expect(paper).not.toContain("sin final");
  });
}

test("on paper a month ahead set by hand is a row before the line, and the count says 13 (RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: the rhythm of 930 ignored on paper; the count taking the screen's rows.
  const id = await seedLeer(db, person);
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 13 meses");
  expect(paper).toContain(monthLabel(2));
  expect(paper).not.toContain(monthLabel(1));
  expect(paper).not.toContain(monthLabel(3));
  const line = paper.indexOf(LINE_TEXT);
  expect(line).toBeGreaterThan(paper.indexOf(monthLabel(2)));
  expect(paper.indexOf(monthLabel(2))).toBeGreaterThan(paper.indexOf(monthLabel(0)));
});

test("on paper a goal with no rhythm folds the empty months ahead into «…: sin monto», with no rhythm line (RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: printing no line for the empty months; printing them as rows; a rhythm line without a rhythm.
  const id = await seedLeer(db, person, { rhythm: null, opened: -2 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 4 meses");
  for (const offset of [-2, -1, 0, 2]) expect(paper, monthLabel(offset)).toContain(monthLabel(offset));
  expect(paper).not.toContain("cada uno");
  expect(paper).not.toContain("los meses que vienen");
  const line = paper.indexOf(": sin monto");
  expect(line, "the «sin monto» line").toBeGreaterThanOrEqual(0);
  const folded = paper.slice(Math.max(0, paper.lastIndexOf(monthLabel(2)) + monthLabel(2).length));
  for (const offset of [1, 3, 11]) expect(folded, longMonth(offset)).toContain(longMonth(offset));
  // The month with an amount is a row, never named by the line.
  expect(folded).not.toContain(longMonth(2));
});

test("on paper a goal that measures nothing, with no task ahead, folds the 11 months into «…: sin tareas» (RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: `printsOnPaper` keeping an `endless` month ahead; the paper without the folded line.
  const id = await seedOpenGoal(db, person, { name: "Sin medida", unit: null, horizon: null, created: openedIn(-2) });
  await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, 'Una tarea', ${monthStartOf(0)}::date)`;
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Sin medida");
  expect(paper).toContain("sin medida · por mes · 3 meses");
  for (const offset of [-2, -1, 0]) expect(paper, monthLabel(offset)).toContain(monthLabel(offset));
  for (const offset of [1, 2, 11]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
  expect(paper).toContain(": sin tareas");
  for (const offset of [1, 6, 11]) expect(paper, longMonth(offset)).toContain(longMonth(offset));
  expect(paper).not.toContain("cada uno");
});

test("on paper a goal that measures nothing prints a month ahead that holds a task as a row (RP-71, RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: the fold swallowing a month ahead with tasks.
  const id = await seedOpenGoal(db, person, { name: "Sin medida", unit: null, horizon: null, created: openedIn(-2) });
  await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, 'Una tarea', ${monthStartOf(0)}::date)`;
  await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, 'Otra tarea', ${monthStartOf(3)}::date)`;
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Sin medida");
  expect(paper).toContain("sin medida · por mes · 4 meses");
  expect(paper).toContain(monthLabel(3));
  const folded = paper.slice(paper.indexOf(": sin tareas") - 400);
  expect(folded).toContain(longMonth(1));
  expect(folded).not.toContain(longMonth(3));
});

test("on paper a group with no end prints its closed months (RP-80, RP-107)", async ({ person, browser, baseURL, db }) => {
  // Kills: filtering the group's `past` months out of the paper.
  const group = await seedOpenGoal(db, person, { name: "Grupo", horizon: null, created: openedIn(-2) });
  // The goal inside opened this month: the closed months can only be the group's own.
  await seedOpenGoal(db, person, { name: "Hijo", parent: group, unit: PAGES, horizon: null, rhythm: 40, created: new Date(Date.now() - 86_400_000) });
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page = await context.newPage();
    await visit(page, "/exportar");
    await expect(page.getByRole("main").getByText("Grupo", { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `ultimos-grupo-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const paper = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ").toLowerCase();
    const from = paper.indexOf("grupo · por mes");
    expect(from, "«Grupo · por mes» on paper").toBeGreaterThanOrEqual(0);
    const section = paper.slice(from, paper.indexOf("hijo · por mes", from) === -1 ? undefined : paper.indexOf("hijo · por mes", from));
    expect(section).toContain(monthLabel(-2));
    expect(section).toContain(monthLabel(-1));
  } finally {
    await context.close();
  }
});
