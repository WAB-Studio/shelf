import { test, expect } from "./fixtures";
import { addTasks, printedPages, seedLeer33, seedShelf } from "./papel-973-seed";
import { budget, openedIn, range } from "./mes-siguiente-seed";
import { PAGES, seedOpenGoal } from "./metas-sin-final-seed";

// Module 973, RP-120, decision 3 of 2026-10-14: on paper a goal's figures — «ESTE MES · {mes}», its number and its «de N»; «HASTA HOY», its
// number and its «de N» — never part between sheets: «si no caben juntas, pasan juntas a la siguiente». Swept over N open tasks that slide
// the cut (docs/TRAPS.md «Chromium print ignores `break-*: avoid` between siblings»); never one PDF. The s7 critic's case: 9 tasks.

const squash = (line: string) => line.replace(/\s+/g, "");
const MONTH_LABEL = (line: string) => squash(line).startsWith("estemes·");
// A sheet never ends on a heading, a figure label, a bare number line, a table head or a «por mes» label.
const ORPHAN = /^(leer|escribir|ahorrar tiempo|vivir mejor|correr 10 km)( · por mes( · \d+( de \d+)? meses?)?)?$|^(este mes|hasta hoy|al terminar|fases|tareas de)|^mes\b.*\bhecho|^[\d—–-]+( [\d—–-]+)?$|^(y )?estos meses con monto propio:$/i;

function checkFigures(pages: string[][], tag: string) {
  const annex = pages.findIndex((lines) => lines.includes("el detalle de cada meta"));
  expect(annex, `${tag}: the annex is in the PDF`).toBeGreaterThanOrEqual(0);
  let blocks = 0;
  pages.forEach((lines, page) => {
    if (page < annex) return;
    lines.forEach((line, at) => {
      if (!MONTH_LABEL(line)) return;
      blocks += 1;
      const goal = [...lines.slice(0, at)].reverse().find((above) => /^(leer|escribir|ahorrar tiempo|vivir mejor|correr 10 km)$/.test(above)) ?? "?";
      expect(squash(line), `${tag}: «ESTE MES» and «HASTA HOY» on one line, sheet ${page + 1}`).toContain("hastahoy");
      expect(lines[at + 1], `${tag}: sheet ${page + 1} keeps the number under «ESTE MES» (it ends on the label)`).toBeDefined();
      expect(lines[at + 1], `${tag}: the figure line under the labels`).toMatch(/^[\d—–-]/);
      // Only a goal with a monthly amount carries a «de N» under its figures. «Ahorrar tiempo» has none, and since RP-124 hides its empty
      // «por mes» nothing follows it: its number may end a sheet, it is the whole block (the figures still share the sheet).
      if (goal === "leer" || goal === "escribir") {
        expect(
          lines[at + 2],
          `${tag}: sheet ${page + 1} ends on the number: the «de N» of «${goal}» opens sheet ${page + 2}`,
        ).toBeDefined();
        expect(lines[at + 2], `${tag}: «${goal}»'s «de N» under its figures`).toMatch(/^de \d+/);
      }
    });
  });
  expect(blocks, `${tag}: the figures of the goals with them are in the PDF`).toBeGreaterThanOrEqual(3);
  pages.forEach((lines, index) => {
    if (index === pages.length - 1) return;
    expect(lines.at(-1), `${tag}: sheet ${index + 1} of ${pages.length} ends on «${lines.at(-1)}»`).not.toMatch(ORPHAN);
  });
}

for (const tasks of range(0, 18))
  test(`P1 sweep: with ${tasks} open tasks of «Leer», every goal's figures share one sheet`, async ({ person, browser, baseURL, db }) => {
    // Kills: `PrintBlock` without `whole` on the figures (676b4961: N = 9 parts «ESTE MES … HASTA HOY» from its number); `whole` on «ESTE MES» alone.
    await seedShelf(db, person, tasks);
    checkFigures(await printedPages(browser, baseURL, person, "/exportar", `f${tasks}`, ["Leer", "Correr 10 km"]), `${tasks} tasks`);
  });

for (const leer of [9, 10, 13, 14])
  for (const tasks of range(0, 10))
    test(`P1 sweep: with ${leer} tasks of «Leer» and ${tasks} of «Escribir», every goal's figures share one sheet`, async ({ person, browser, baseURL, db }) => {
      // Kills: the same, for a goal further down the sheet.
      await seedShelf(db, person, leer, tasks);
      checkFigures(await printedPages(browser, baseURL, person, "/exportar", `e${leer}-${tasks}`, ["Leer", "Correr 10 km"]), `${leer}+${tasks} tasks`);
    });

// A goal whose two figures differ in height: «ESTE MES» with a «de 0» over a «HASTA HOY» with only its number, or the other way round
// (a budget in a past month alone). Its note slides the cut by a line at a time. Swept where the cut falls inside the figures.
for (const kind of ["month taller", "to-date taller"] as const)
  for (const [leer, noteWords] of [[10, 0], [8, 36], [9, 18], [9, 0], [10, 18]] as const)
    test(`P2 sweep: a goal with ${kind} figures, after ${leer} tasks of «Leer» and a note of ${noteWords} words, keeps them on one sheet`, async ({ person, browser, baseURL, db }) => {
      // Kills: `PrintBlock` without `whole` on the figures of either half (both removed: the number is cut from its «de N»).
      await seedLeer33(db, person, leer);
      const goal = await seedOpenGoal(db, person, { name: "Segunda", unit: PAGES, horizon: null, rhythm: null, created: openedIn(-5), note: noteWords === 0 ? null : "palabra ".repeat(noteWords).trim() });
      await budget(db, person, goal, kind === "month taller" ? 0 : -1, kind === "month taller" ? 0 : 40);
      await addTasks(db, person, goal, 4, "Pendiente");
      const pages = await printedPages(browser, baseURL, person, "/exportar", `p2-${leer}-${noteWords}`, ["Leer", "Segunda"]);
      let blocks = 0;
      pages.forEach((lines, page) =>
        lines.forEach((line, at) => {
          if (!MONTH_LABEL(line)) return;
          blocks += 1;
          expect(squash(line), `sheet ${page + 1}: «ESTE MES» and «HASTA HOY» on one line`).toContain("hastahoy");
          expect(lines[at + 1], `sheet ${page + 1}: the figure line under the labels`).toMatch(/^[\d—–-]/);
          expect(lines[at + 2], `sheet ${page + 1} ends on the number: the «de N» opens sheet ${page + 2}`).toBeDefined();
        }),
      );
      expect(blocks, "the figures of both goals are in the PDF").toBeGreaterThanOrEqual(2);
    });
