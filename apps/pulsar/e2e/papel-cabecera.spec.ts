import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect } from "./fixtures";
import { dayBefore } from "./meta-arbol-seed";
import { PAGES, openedOnDay, seedHabit, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf, shift, TODAY } from "./sin-final-seed";
import { budget, openedIn, range } from "./mes-siguiente-seed";
import { civilDateToDate } from "@/lib/zone";

import type { Browser, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Module 953, RP-116, board PapelCabeceraPegada (decision 3): on paper a goal's head, its figures, its «por mes» label and its first
// rows share a sheet; the table breaks between rows only, repeats MES / HECHO / PLANEADO where it continues, and the closing line
// «N meses más, hasta el …» follows the last row of the last table on that row's sheet. A goal that fits a sheet stays whole (803).
// Contract: private/953-contrato.md (P1). The seed is the critic's (`private/ux-s5/seed.mjs`) with every date relative to today, and
// the sweep moves the page cut with N open tasks of the goal itself (docs/TRAPS.md «Chromium print ignores `break-*: avoid`…»), never one PDF.

const A4 = { width: 794, height: 1123 };
const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const wordsOf = (day: string) => `${Number(day.slice(8, 10))} ${ABBR[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const horizonIn = (offset: number): string => {
  let day = shift(monthStartOf(offset), 1);
  while (civilDateToDate(day).getUTCDay() !== 1) day = shift(day, 1);
  return day;
};
const GOALS = ["Leer", "Escribir", "Ahorrar tiempo", "Vivir mejor", "Correr 10 km"];

// «Leer» ends in month +3 with December (+2) set to 60: 13 rows in the first table, one own-amount row, 1 month left out.
async function seedCritic(db: Db, person: Person, openTasks: number) {
  const leer = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: horizonIn(3), rhythm: 40, created: openedIn(-23) });
  await budget(db, person, leer, 2, 60);
  for (const n of range(0, openTasks - 1)) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${leer}, ${`Tarea abierta ${n}`}, ${monthStartOf(0)}::date)`;
  }
  await seedOpenGoal(db, person, { name: "Escribir", unit: PAGES, horizon: null, rhythm: 30, created: openedOnDay(1).at });
  await seedOpenGoal(db, person, { name: "Ahorrar tiempo", unit: PAGES, horizon: null, rhythm: null, created: openedIn(-7) });
  await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, horizon: null, rhythm: null, created: openedIn(-4) });
  const correr = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: null, horizon: horizonIn(2), rhythm: null, created: openedOnDay(1).at });
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${correr}, 'Preparación', ${shift(TODAY, -9)}::date, ${shift(TODAY, 39)}::date)`;
  await seedHabit(db, person, { name: "Tomar agua", cadence: "daily" });
  await seedHabit(db, person, { name: "Caminar", cadence: "weekdays", weekdays: [1, 3, 5] });
  await seedHabit(db, person, { name: "Llamar a mamá", cadence: "times_per_week", n: 1 });
  return leer;
}

async function printedPages(browser: Browser, baseURL: string | undefined, person: Person, tag: string): Promise<string[][]> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page: Page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("main").getByText("Correr 10 km", { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `cabecera-${tag}-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const count = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8" }))![1]);
    return Array.from({ length: count }, (_, i) =>
      execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
        .toLowerCase()
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    );
  } finally {
    await context.close();
  }
}

// A header set in tracked capitals comes out of the PDF with a space between letters: «h e c h o».
const spaced = (word: string) => word.split("").join(" ?");
const HEAD = new RegExp(`^${spaced("mes")} .*${spaced("hecho")}.*${spaced("planeado")}`, "i");
const ROW = new RegExp(`^(${NAMES.join("|")}) \\d{4}\\b`);
const LABEL = "leer · por mes · 14 meses";
const MONTHS_LEFT = lineWords();

function lineWords() {
  return `1 mes más, hasta el ${wordsOf(dayBefore(horizonIn(3)))}`;
}

type At = { page: number; at: number };
function locate(pages: string[][]) {
  const annex = pages.findIndex((lines) => lines.includes("el detalle de cada meta"));
  expect(annex, "the annex label «el detalle de cada meta» in the PDF").toBeGreaterThanOrEqual(0);
  // «Leer» also heads the summary on sheet 1: its own heading is the first one from the annex on.
  const found: At[] = [];
  pages.forEach((lines, page) => lines.forEach((line, at) => page >= annex && line === "leer" && found.push({ page, at })));
  expect(found.length, "«Leer»'s heading in the annex").toBeGreaterThan(0);
  const name = found[0];
  const label: At = { page: -1, at: -1 };
  pages.forEach((lines, page) => {
    const at = lines.indexOf(LABEL);
    if (at >= 0 && label.page < 0) Object.assign(label, { page, at });
  });
  expect(label.page, `«${LABEL}» in the PDF`).toBeGreaterThanOrEqual(0);
  // Leer's span ends where the next goal's heading begins; its tables print the same months.
  const next: At = { page: pages.length, at: 0 };
  pages.forEach((lines, page) =>
    lines.forEach((line, at) => {
      if (line === "escribir" && page >= annex && (page > label.page || (page === label.page && at > label.at)) && next.page === pages.length)
        Object.assign(next, { page, at });
    }),
  );
  const rows = range(-11, 2).map((offset) => {
    const hits: At[] = [];
    pages.forEach((lines, page) =>
      lines.forEach((line, at) => {
        const after = page > label.page || (page === label.page && at > label.at);
        const before = page < next.page || (page === next.page && at < next.at);
        if (after && before && line.startsWith(monthLabel(offset))) hits.push({ page, at });
      }),
    );
    expect(hits, `row ${monthLabel(offset)} printed exactly once after the label`).toHaveLength(1);
    return hits[0];
  });
  return { annex, name, label, rows };
}

// The text the check below reads as the head of a goal that must never end a sheet.
const ORPHAN = new RegExp(
  `^(${GOALS.map((goal) => goal.toLowerCase()).join("|")})( · por mes( · \\d+ meses?)?)?$|^(este mes|hasta hoy|al terminar|fases|tareas de)|^mes\\b.*\\bhecho|^\\d+ meses?$`,
  "i",
);

function checkPaper(pages: string[][], tag: string) {
  const w = locate(pages);
  // Head, figures, label and first row on one sheet.
  expect(w.label.page, `${tag}: «${LABEL}» on sheet ${w.label.page + 1}, «Leer»'s heading on sheet ${w.name.page + 1}`).toBe(w.name.page);
  expect(w.rows[0].page, `${tag}: first row «${monthLabel(-11)}» on the sheet of the label`).toBe(w.label.page);
  const figures = pages[w.name.page].findIndex((line, at) => at > w.name.at && /^(este mes|hasta hoy)/.test(line));
  expect(figures, `${tag}: Leer's figures on its sheet`).toBeGreaterThan(w.name.at);
  expect(figures, `${tag}: the figures above the label`).toBeLessThan(w.label.at);
  // No sheet ends on a heading, a figure line, a label or a table head.
  pages.forEach((lines, index) => {
    if (index === pages.length - 1) return;
    expect(lines.at(-1), `${tag}: sheet ${index + 1} of ${pages.length} ends on «${lines.at(-1)}»`).not.toMatch(ORPHAN);
  });
  // The table breaks between rows: each row whole (its cells under it), in order, none lost.
  w.rows.forEach((row, index) => {
    const cells = pages[row.page][row.at + 1];
    expect(cells, `${tag}: ${monthLabel(index - 11)} has its cells under it on sheet ${row.page + 1}`).toBeDefined();
    expect(cells, `${tag}: ${monthLabel(index - 11)}: the next line is its cells, not another month`).not.toMatch(ROW);
    if (index > 0) {
      const before = w.rows[index - 1];
      expect(row.page > before.page || (row.page === before.page && row.at > before.at), `${tag}: order at ${monthLabel(index - 11)}`).toBe(true);
    }
  });
  // Where it continues, MES / HECHO / PLANEADO opens the sheet's rows.
  for (const page of new Set(w.rows.map((row) => row.page))) {
    if (page === w.label.page) continue;
    const first = Math.min(...w.rows.filter((row) => row.page === page).map((row) => row.at));
    expect(pages[page].slice(0, first).some((line) => HEAD.test(line)), `${tag}: sheet ${page + 1} opens its rows with the head`).toBe(true);
    expect(first, `${tag}: the head is the first thing above the rows on sheet ${page + 1}`).toBeLessThanOrEqual(3);
  }
  // «estos meses con monto propio:», December, then the line, together on the sheet of December.
  const december = w.rows[w.rows.length - 1];
  const label = pages[december.page].findIndex((line) => line === "estos meses con monto propio:");
  const left = pages[december.page].findIndex((line) => line.startsWith(MONTHS_LEFT));
  expect(left, `${tag}: «${MONTHS_LEFT}» on sheet ${december.page + 1}, where December is`).toBeGreaterThan(december.at);
  expect(left - december.at, `${tag}: the line right behind December's cells`).toBeLessThanOrEqual(3);
  if (label >= 0) expect(label, `${tag}: the label before December`).toBeLessThan(december.at);
  else {
    // The label closes the sheet before: December starts the next one, with the label right above the table's head.
    const before = pages[december.page - 1];
    expect(before?.some((line) => line === "estos meses con monto propio:"), `${tag}: «estos meses con monto propio:» printed`).toBe(true);
  }
  return w;
}

test("P1: Leer's head, figures, label and first row share a sheet; the table continues with its head; the line follows December", async ({
  person, browser, baseURL, db,
}) => {
  // Kills: the «por mes» block `whole` as before (`!isLongTable`): the head alone on one sheet, the table whole on the next.
  await seedCritic(db, person, 0);
  checkPaper(await printedPages(browser, baseURL, person, "p1"), "p1");
});

test("P1: the critic's paper takes fewer sheets than the six it took on b50f3fea", async ({ person, browser, baseURL, db }) => {
  // Kills: a head left alone on a sheet, which costs the sheet the table then fills.
  await seedCritic(db, person, 0);
  const pages = await printedPages(browser, baseURL, person, "p1n");
  expect(pages.length, `the PDF has ${pages.length} sheets`).toBeLessThan(6);
});

// Open tasks of the goal itself grow its head and slide the cut along the table, across the head, figures and label.
for (const tasks of range(1, 15))
  test(`P1 sweep: with ${tasks} open tasks above its table, Leer's head is never alone, its rows are whole and the line follows December`, async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: the «por mes» block `whole`; the head without its table (`PrintGoal whole` only for 8–19 rows); the line outside the last table's `after`.
    await seedCritic(db, person, tasks);
    checkPaper(await printedPages(browser, baseURL, person, `sw${tasks}`), `${tasks} tasks`);
  });
