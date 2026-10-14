import { test, expect } from "./fixtures";
import { printedPages, seedShelf } from "./papel-973-seed";
import { range } from "./mes-siguiente-seed";

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
      expect(
        lines[at + 2],
        `${tag}: sheet ${page + 1} ends on the number: the «de N» of «${goal}» opens sheet ${page + 2}`,
      ).toBeDefined();
      if (goal === "leer" || goal === "escribir") {
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
