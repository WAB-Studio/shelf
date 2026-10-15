import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { expect, visit, type Person } from "./fixtures";
import { PAGES, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf } from "./sin-final-seed";

// Seeds and readers of the specs of module 939 (RP-110): next month as its own row. A helper file, not a spec.
// Every month is an offset from the real current month, so a spec runs on any day.

export type Db = postgres.Sql;

export const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
export const monthKey = (offset: number) => monthStartOf(offset).slice(0, 7);
export const monthName = (offset: number) => NAMES[Number(monthStartOf(offset).slice(5, 7)) - 1];
export const monthHref = (id: string, offset: number) => `/metas/${id}/meses/${monthKey(offset)}`;
export const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// The 5th of a month `offset` from this one, as E1 opens («abierta el 5 nov 2024»).
export const openedIn = (offset: number) => new Date(`${monthStartOf(offset).slice(0, 8)}05T12:00:00Z`);

// How the fold line of paper names a month, as its rows do: «noviembre 2026».
export const longMonth = (offset: number) => `${monthName(offset)} ${monthStartOf(offset).slice(0, 4)}`;

export const AHEAD40 = /los demás meses que vienen: 40 páginas cada uno/i;
export const OLD_AHEAD = /\blos meses que vienen\b/i;
export const AND_OWN = /^y estos meses con monto propio:$/i;
export const OWN = /^estos meses con monto propio:$/i;

export async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width: number) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

// E1: «Leer», no end, opened the 5th of a month 23 months back, pages, 40 a month unless told otherwise.
export async function seedLeer(db: Db, person: Person, opts: { rhythm?: number | null; opened?: number; name?: string } = {}) {
  return seedOpenGoal(db, person, {
    name: opts.name ?? "Leer",
    unit: PAGES,
    horizon: null,
    rhythm: opts.rhythm === undefined ? 40 : opts.rhythm,
    created: openedIn(opts.opened ?? -23),
  });
}

// A month's amount set by hand, as «Planear» writes it.
export async function budget(db: Db, person: Person, goalId: string, offset: number, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${monthStartOf(offset)}::date, ${amount})`;
}

// Where each month row of «Por mes» leads: month key -> the distinct hrefs of its rows. A row is a link that names its
// month and year («octubre 2026»); it leads either to the month's page or to the amount sheet (`?planear=`). The links
// that open the whole list (`todo=`) and the page's own «Planear» link name no month and year.
export async function monthTargets(page: Page, id: string): Promise<Record<string, string[]>> {
  const links = await page.locator(`main a[href^="/metas/${id}/meses"]`).evaluateAll((anchors) =>
    anchors.map((a) => ({ href: (a as HTMLAnchorElement).getAttribute("href") ?? "", text: (a.textContent ?? "").toLowerCase() })),
  );
  const found: Record<string, Set<string>> = {};
  for (const { href, text } of links) {
    if (href.includes("todo=")) continue;
    const named = new RegExp(`\\b(${NAMES.join("|")}) (\\d{4})\\b`).exec(text);
    if (!named) continue;
    const month = `${named[2]}-${String(NAMES.indexOf(named[1]) + 1).padStart(2, "0")}`;
    (found[month] ??= new Set()).add(href);
  }
  return Object.fromEntries(Object.entries(found).map(([month, set]) => [month, [...set]]));
}
export async function rowMonths(page: Page, id: string): Promise<string[]> {
  return Object.keys(await monthTargets(page, id)).sort();
}
export const keysFor = (offsets: number[]) => offsets.map(monthKey).sort();

// The visible link of a month's row on «Por mes».
export const rowLink = (page: Page, id: string, offset: number): Locator =>
  page
    .locator(`main a[href^="/metas/${id}/meses"]:visible`)
    .filter({ hasText: new RegExp(monthLabel(offset), "i") });

export const lineLink = (scope: Page | Locator) => scope.getByRole("link", { name: AHEAD40 });
export const seeAll = (scope: Page | Locator) => scope.getByRole("link", { name: "ver todo", exact: true });
export const textOf = (scope: Page | Locator, pattern: RegExp) => scope.getByText(pattern).locator("visible=true");

export const mainLower = async (page: Page) => (await page.locator("main").innerText()).replace(/\s+/g, " ").toLowerCase();

export async function yOf(locator: Locator): Promise<{ top: number; bottom: number }> {
  const box = await locator.first().boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return { top: box!.y, bottom: box!.y + box!.height };
}

// ---- The report on screen ---------------------------------------------------------------------------------------

// Panel, PrintBlock and Section nest: the innermost one holds the label, the rows, the line and «ver todo».
export const sectionOf = (page: Page, name: string) =>
  page.locator("section").filter({ has: page.getByText(`${name} · por mes`, { exact: true }) }).last();
export const reportRow = (section: Locator, offset: number) =>
  section.locator("li:visible, tbody tr:visible").filter({ hasText: new RegExp(monthLabel(offset), "i") });

// ---- Paper ---------------------------------------------------------------------------------------------------------

const A4 = { width: 794, height: 1123 };

// One goal's text on paper, from its «por mes» label to the next label (or the end), lowercase, one run.
// A goal that measures nothing and holds nothing prints no «por mes» (RP-124): `labelled` false hands back the whole sheet.
export async function paperOf(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, name: string, labelled = true): Promise<string> {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page = await context.newPage();
    await visit(page, path);
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `siguiente-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const flat = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ").toLowerCase();
    const label = `${name} · por mes`.toLowerCase();
    const from = flat.indexOf(label);
    if (!labelled) return flat;
    expect(from, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
    const to = flat.indexOf("· por mes", from + label.length);
    return flat.slice(from, to === -1 ? undefined : to);
  } finally {
    await context.close();
  }
}

// Positions in `text` must grow in the order given; each is searched after the one before.
export function expectInOrder(text: string, needles: string[]) {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    expect(at, `«${needle}» after position ${from} in: ${text.slice(0, 1500)}`).toBeGreaterThanOrEqual(0);
    from = at + needle.length;
  }
}
