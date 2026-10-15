import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect } from "./fixtures";
import { MINUTES, PAGES, openedOnDay, seedHabit, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf, shift, TODAY } from "./sin-final-seed";
import { budget, longMonth, openedIn, paperOf, range } from "./mes-siguiente-seed";
import { horizonIn } from "./por-mes-de-n-seed";

import type { Browser, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Module 965, RP-118, boards PapelTareasPares, PapelEtiquetaPegada and PapelSinMontoSinFinal (decisions 2, 3 and Q6 (c)).
// On paper the first two tasks of a goal, and its last two, never part (a goal of one task prints as before); the label «estos meses con monto
// propio:» travels with the first row of its table, so it shares a sheet with December and never ends one; a goal with no end prints no line for
// months ahead that hold no amount and no task, and keeps the line of a month that holds tasks. The sweep moves the cut with N open tasks of
// the goal itself, never one PDF (docs/TRAPS.md «Chromium print ignores `break-*: avoid` between siblings»). Contract: plan s7 `## 965` (T1, T2).

test.use({ actionTimeout: 6000 });

const A4 = { width: 794, height: 1123 };
const OWN_LABEL = "estos meses con monto propio:";

// The critic's seed (private/ux-s5/seed.mjs) with every date relative to today: «Leer» ends in month +3 with December (+2) at 60.
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
    const file = resolve(dir, `pares-${tag}-${Date.now()}.pdf`);
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

const TASK = /^tarea abierta \d+/;
const isTask = (line: string) => TASK.test(line);

// The sweep of the cut: 0 and 1 task (as before), 2, and 10 to 15 where the head, its tasks and the table fill and cross a sheet.
for (const tasks of [0, 1, 2, 10, 11, 12, 13, 14, 15])
  test(`T1 with ${tasks} open tasks: no sheet holds a single task of a goal of two or more, the summary stays alone on sheet 1, the label shares December's sheet`, async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: tasks with no pair kept together (5383eefa): a sheet opens or closes on one task; the label in the `after` of the first table:
    // it ends a sheet and December opens the next; `PrintBlock newPage` of the summary removed.
    await seedCritic(db, person, tasks);
    const pages = await printedPages(browser, baseURL, person, `t${tasks}`);
    const perSheet = pages.map((lines) => lines.filter(isTask).length);
    expect(perSheet.reduce((sum, n) => sum + n, 0), `${tasks} tasks printed once each: ${perSheet}`).toBe(tasks);
    if (tasks >= 2)
      perSheet.forEach((count, index) =>
        expect(count, `${tasks} tasks, per sheet ${perSheet}: sheet ${index + 1} holds one task alone`).not.toBe(1),
      );
    if (tasks > 0) {
      const first = perSheet.findIndex((count) => count > 0);
      const lines = pages[first];
      const head = lines.findIndex(isTask);
      if (tasks >= 2 && first > 0) {
        // The sheet that opens with tasks carries at least two of them: what sits above them is the goal's head, never a lone task.
        expect(lines.slice(head).filter(isTask).length, `first task sheet ${first + 1}`).toBeGreaterThanOrEqual(2);
      }
    }
    // The summary stays alone on sheet 1: no task and no «por mes» table of the detail.
    expect(pages[0].filter(isTask), "sheet 1 holds no task").toEqual([]);
    expect(pages[0].some((line) => line.includes("· por mes")), "sheet 1 holds no detail table").toBe(false);
    expect(pages[0].some((line) => /^leer \d+ de [\d.]+ páginas/.test(line)), "sheet 1 holds the summary row of Leer").toBe(true);
    // The label shares a sheet with December, above it; no sheet ends on it.
    const withLabel = pages.flatMap((lines, page) => lines.map((line, at) => ({ line, page, at }))).filter((entry) => entry.line === OWN_LABEL);
    expect(withLabel, "the label printed once").toHaveLength(1);
    const { page, at } = withLabel[0];
    const december = pages[page].findIndex((line, index) => index > at && line.startsWith(monthLabel(2)));
    expect(december, `${tasks} tasks: «${monthLabel(2)}» on sheet ${page + 1} after the label (sheet ends on «${pages[page].at(-1)}»)`).toBeGreaterThan(at);
    expect(pages[page].at(-1), `sheet ${page + 1} does not end on the label`).not.toBe(OWN_LABEL);
  });

test("T2: a goal with no end, no rhythm and months ahead with nothing prints no «…: sin monto» line", async ({ person, browser, baseURL, db }) => {
  // Kills: the fold line of months with no amount kept for a goal with no end (5383eefa).
  await seedOpenGoal(db, person, { name: "Ahorrar tiempo", unit: PAGES, horizon: null, rhythm: null, created: openedIn(-7) });
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Ahorrar tiempo");
  expect(paper).toContain("ahorrar tiempo · por mes · 9 meses");
  expect(paper).toContain(monthLabel(-7));
  expect(paper).toContain(monthLabel(1));
  expect(paper).not.toContain(": sin monto");
  for (const offset of [2, 5, 11]) expect(paper, longMonth(offset)).not.toContain(longMonth(offset));
});

test("T2 control: a goal in minutes with no rhythm and no end keeps «enero …: sin monto · 1 tarea» for the month that holds a task", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping the line of a month with tasks too (the whole line, not only the empty months).
  const id = await seedOpenGoal(db, person, { name: "Estudiar", unit: MINUTES, horizon: null, rhythm: null, created: openedIn(-2) });
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${id}, ${"Entregar"}, ${monthStartOf(3)}::date)`;
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Estudiar");
  expect(paper).toContain(`${longMonth(3)}: sin monto · 1 tarea`);
});

test("T2 no measure: a goal with no end and no measure prints no «…: sin tareas» line for months ahead with no task", async ({ person, browser, baseURL, db }) => {
  // Kills: the guard on `horizon === null` in the line of months out of a goal with no measure (Q6 (c)).
  await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, horizon: null, rhythm: null, created: openedIn(-4) });
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Vivir mejor", false);
  expect(paper, "nothing to put in it: no «por mes»").not.toContain("vivir mejor · por mes");
  expect(paper).toContain("vivir mejor");
  expect(paper).not.toContain(": sin tareas");
  expect(paper).not.toContain(": sin monto");
  for (const offset of [2, 5, 11]) expect(paper, longMonth(offset)).not.toContain(longMonth(offset));
});
