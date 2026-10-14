import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect } from "./fixtures";
import { PAGES, openedOnDay, seedHabit, seedOpenGoal } from "./metas-sin-final-seed";
import { monthStartOf, shift, TODAY } from "./sin-final-seed";
import { openedIn, range, monthName } from "./mes-siguiente-seed";
import { horizonIn } from "./por-mes-de-n-seed";

import type { Browser, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Module 980, board PapelTareasRotulo (approved 2026-10-14): on paper a goal's task list that runs onto the next sheet repeats its label
// («TAREAS DE OCTUBRE») above the continuation; a list that fits a sheet prints it once. Swept with N open tasks of «Leer» (6, 10 to 16) so
// the cut falls in the list, as `papel-cabecera.spec.ts` does (docs/TRAPS.md «Chromium print ignores `break-*: avoid` between siblings»).
// Written from the contract; every date is relative to today.

test.use({ actionTimeout: 6000 });

const A4 = { width: 794, height: 1123 };
const LABEL = new RegExp(`^tareas de ${monthName(0)}\\b`);
const TASK = /^tarea abierta (\d+)/;

async function seedLeer(db: Db, person: Person, openTasks: number) {
  const leer = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, horizon: horizonIn(3), rhythm: 40, created: openedIn(-23) });
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${leer}, 'Escoger', ${shift(TODAY, -60)}::date, ${shift(TODAY, -21)}::date),
           (${person.id}, ${leer}, 'Leer de a poco', ${shift(TODAY, -20)}::date, ${shift(TODAY, 20)}::date),
           (${person.id}, ${leer}, 'Terminar', ${shift(TODAY, 21)}::date, ${shift(TODAY, 80)}::date)`;
  for (const n of range(0, openTasks - 1)) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${leer}, ${`Tarea abierta ${n}`}, ${monthStartOf(0)}::date)`;
  }
  await seedOpenGoal(db, person, { name: "Escribir", unit: PAGES, horizon: null, rhythm: 30, created: openedOnDay(1).at });
  await seedHabit(db, person, { name: "Tomar agua", cadence: "daily" });
}

async function printedPages(browser: Browser, baseURL: string | undefined, person: Person, tag: string): Promise<string[][]> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page: Page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("main").getByText("Escribir", { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `rotulo-${tag}-${Date.now()}.pdf`);
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

function checkLabels(pages: string[][], tag: string, tasks: number) {
  const sheets = pages.map((lines, page) => ({ page, lines, first: lines.findIndex((l) => TASK.test(l)) })).filter((s) => s.first >= 0);
  // Every task prints exactly once, in order.
  const printed = pages.flatMap((lines) => lines.filter((l) => TASK.test(l)).map((l) => Number(TASK.exec(l)![1])));
  expect(printed, `${tag}: the ${tasks} tasks printed once each, in order`).toEqual(range(0, tasks - 1));
  // Each sheet that carries tasks opens them with the label, right above the first one.
  for (const sheet of sheets)
    expect(sheet.lines[sheet.first - 1] ?? "", `${tag}: sheet ${sheet.page + 1}: the line above its first task`).toMatch(LABEL);
  // Never a label without its tasks under it: one label per sheet with tasks, none elsewhere.
  const labels = pages.flatMap((lines, page) => lines.map((line, at) => ({ line, page, at })).filter((e) => LABEL.test(e.line)));
  expect(labels.map((l) => l.page), `${tag}: the label printed once per sheet that carries tasks`).toEqual(sheets.map((s) => s.page));
  return sheets;
}

for (const tasks of [6, 10, 11, 12, 13, 14, 15, 16])
  test(`with ${tasks} open tasks, every sheet of the list opens with «tareas de ${monthName(0)}», printed once per sheet`, async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: the label printed only once, above the first sheet's tasks (the continuation opens on a bare task, as on 55fe164f);
    // the label repeated on a sheet with no tasks; a list that fits repeating its label.
    await seedLeer(db, person, tasks);
    checkLabels(await printedPages(browser, baseURL, person, `n${tasks}`), `${tasks} tasks`, tasks);
  });

test("the sweep reaches both cases: 6 tasks sit on one sheet, 16 run onto a second", async ({ person, browser, baseURL, db }) => {
  // Kills: a sweep that never splits the list (every N then trivially prints one label) or never keeps it whole.
  await seedLeer(db, person, 16);
  const long = checkLabels(await printedPages(browser, baseURL, person, "split16"), "16 tasks", 16);
  expect(long.length, "16 tasks span two sheets").toBeGreaterThanOrEqual(2);
});

test("6 tasks that fit a sheet print the label once and keep every task under it", async ({ person, browser, baseURL, db }) => {
  // Kills: a repeat of the label on a list that does not continue.
  await seedLeer(db, person, 6);
  const sheets = checkLabels(await printedPages(browser, baseURL, person, "fit6"), "6 tasks", 6);
  expect(sheets).toHaveLength(1);
});
