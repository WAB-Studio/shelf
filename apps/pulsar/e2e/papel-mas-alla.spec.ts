import { test, expect, type Person } from "./fixtures";
import { addTasks, printedPages, seedShelf } from "./papel-973-seed";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type postgres from "postgres";

// Module 1003 (RP-77): the paper rules the sweeps prove inside closed ranges, drawn again past each range's ceiling. One PDF per point.
// The page extractor is `printedPages` (papel-973-seed.ts), the one papel-cifras-juntas.spec.ts reads with; the checks below restate the
// rules of papel-cifras-juntas.spec.ts:13–47 and papel-tabla-larga.spec.ts:108–150, 236, 290– (those files export nothing to import).

const squash = (line: string) => line.replace(/\s+/g, "");
const MONTH_LABEL = (line: string) => squash(line).startsWith("estemes·");
const ORPHAN = /^(leer|escribir|ahorrar tiempo|vivir mejor|correr 10 km)( · por mes( · \d+( de \d+)? meses?)?)?$|^(este mes|hasta hoy|por mes|al terminar|fases|tareas de)|^mes\b.*\bhecho|^[\d—–-]+( [\d—–-]+)?$|^(y )?estos meses con monto propio:$/i;
const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const labelOf = (offset: number) => `${NAMES[Number(startOf(offset).slice(5, 7)) - 1]} ${startOf(offset).slice(0, 4)}`;

function noSheetEndsOnALabel(pages: string[][], tag: string) {
  pages.forEach((lines, index) => {
    if (index === pages.length - 1) return;
    expect(lines.at(-1), `${tag}: sheet ${index + 1} of ${pages.length} ends on «${lines.at(-1)}»`).not.toMatch(ORPHAN);
  });
}

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
      expect(lines[at + 1], `${tag}: sheet ${page + 1} keeps the number under «ESTE MES»`).toBeDefined();
      expect(lines[at + 1], `${tag}: the figure line under the labels`).toMatch(/^[\d—–-]/);
      if (goal === "leer" || goal === "escribir") {
        expect(lines[at + 2], `${tag}: sheet ${page + 1} ends on the number: the «de N» of «${goal}» opens the next sheet`).toBeDefined();
        expect(lines[at + 2], `${tag}: «${goal}»'s «de N» under its figures`).toMatch(/^de \d+/);
      }
    });
  });
  expect(blocks, `${tag}: the figures of the goals with them are in the PDF`).toBeGreaterThanOrEqual(3);
  noSheetEndsOnALabel(pages, tag);
}

// Cifras juntas past the sweep's 0…17 and its leer 9…14 × 0…9. Each cut falls every 15 tasks (9, 25, 40, 55): the points sit on a cut, where a missing `whole` parts the figures.
for (const tasks of [25, 40, 55])
  test(`beyond the sweep: with ${tasks} open tasks of «Leer», every goal's figures share one sheet and no sheet ends on a label`, async ({ person, browser, baseURL, db }) => {
    // Kills: `PrintBlock` without `whole` on the figures (all of `whole` in `PrintBlock`). Not `whole` on «ESTE MES» alone: «HASTA HOY» sits beside it in one grid row, and 70 points (0…69 tasks) never part them.
    await seedShelf(db, person, tasks);
    checkFigures(await printedPages(browser, baseURL, person, "/exportar", `mf${tasks}`, ["Leer", "Correr 10 km"]), `${tasks} tasks`);
  });

test("beyond the sweep: with 20 tasks of «Leer» and 12 of «Escribir», every goal's figures share one sheet", async ({ person, browser, baseURL, db }) => {
  await seedShelf(db, person, 20, 12);
  checkFigures(await printedPages(browser, baseURL, person, "/exportar", "me20-12", ["Leer", "Correr 10 km"]), "20+12 tasks");
});

// A goal of `months` measured months (an amount in each), ending two months after the last; `above` open tasks of a goal before it.
async function seedMeasured(db: postgres.Sql, person: Person, name: string, months: number, tasksOnIt = 0) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${startOf(months + 2)}::date, 'Práctica', 'minutos',
            (${startOf(0)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id`;
  for (const offset of range(months))
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${startOf(offset)}::date, 600)`;
  for (const n of range(tasksOnIt))
    await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${goal.id}, ${`Tarea abierta ${n}`}, ${startOf(0)}::date)`;
  return goal.id;
}

async function seedFiller(db: postgres.Sql, person: Person, tasks: number) {
  const [filler] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${"Previa"}, ${startOf(3)},
            (${startOf(0)}::date + interval '13 days' + interval '12 hours')::timestamptz)
    returning id`;
  await addTasks(db, person, filler.id, tasks, "Previa");
}

const labelIndex = (pages: string[][], name: string) => {
  const page = pages.findIndex((lines) => lines.some((l) => l.startsWith(`${name} · por mes`)));
  expect(page, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
  return { page, at: pages[page].findIndex((l) => l.startsWith(`${name} · por mes`)) };
};
const isRow = (line: string) => new RegExp(`^(${NAMES.join("|")}) \\d{4}`).test(line);

// 803 at every table height. A goal of 8 rows or more keeps its head with its label: the page cut falls on «above» = 8, 9, 11, 24, 25, 39, 40, 54
// and 55 (every 15 tasks), where the head without `whole` is left alone on the sheet before its label.
for (const [months, above] of [[12, 25], [12, 40], [12, 55], [24, 0], [24, 8], [24, 9], [24, 11], [24, 16], [24, 24], [24, 25], [24, 39], [24, 40], [24, 54], [24, 55], [36, 0], [36, 16], [36, 25], [36, 40], [46, 25], [46, 40]] as const)
  test(`beyond the sweep: a ${months}-month goal under another goal's ${above} open tasks has its name on the page of its «por mes» label`, async ({ person, browser, baseURL, db }) => {
    // Kills: `whole` removed from the `PrintGoal` of the head (12 months); `whole` forced on the months table (blank sheet); `whole` dropped from the `PrintGoal` of a table of 20 rows or more (24 months at the cuts).
    const name = `Inglés ${months} meses`;
    if (above > 0) await seedFiller(db, person, above);
    await seedMeasured(db, person, name, months);
    const pages = await printedPages(browser, baseURL, person, "/exportar", `803-${months}x${above}`, [name]);
    const lowered = name.toLowerCase();
    const namePage = pages.findIndex((lines) => lines.includes(lowered));
    expect(namePage, "goal name in the PDF").toBeGreaterThanOrEqual(0);
    const label = labelIndex(pages, lowered);
    expect(label.page, `label on sheet ${label.page + 1}, the goal's name on sheet ${namePage + 1}`).toBe(namePage);
    const after = pages[label.page].slice(label.at + 1).findIndex(isRow);
    expect(after, "its first row on the label's sheet, under it").toBeGreaterThanOrEqual(0);
    expect(label.at, "the label is not the last line of its sheet").toBeLessThan(pages[label.page].length - 1);
    noSheetEndsOnALabel(pages, `${months}x${above}`);
  });

// A table longer than a sheet breaks between rows, keeps its label on the first, and the «N meses más» line behind the last row.
for (const tasks of [32, 48])
  test(`beyond the sweep: a 46-month table under ${tasks} open tasks breaks between rows, label on its first sheet, line behind the last row`, async ({ person, browser, baseURL, db }) => {
    const name = `Inglés largo`;
    await seedMeasured(db, person, name, 46, tasks);
    const pages = await printedPages(browser, baseURL, person, "/exportar", `long${tasks}`, [name]);
    const lowered = name.toLowerCase();
    const namePage = pages.findIndex((lines) => lines.includes(lowered));
    const label = labelIndex(pages, lowered);
    expect(namePage, "goal name in the PDF").toBeGreaterThanOrEqual(0);
    const rows: { page: number; at: number }[] = [];
    pages.forEach((lines, page) =>
      lines.forEach((line, at) => {
        if ((page > label.page || (page === label.page && at > label.at)) && isRow(line)) rows.push({ page, at });
      }),
    );
    // Months 0…45 plus the months left out of the second table are printed once each.
    for (const offset of range(46)) {
      expect(rows.filter(({ page, at }) => pages[page][at].startsWith(labelOf(offset))), `row ${labelOf(offset)} printed once`).toHaveLength(1);
    }
    expect(new Set(rows.map((r) => r.page)).size, "the table spans more than one sheet").toBeGreaterThan(1);
    expect(rows[0].page, "first row with the label").toBe(label.page);
    expect(label.at, "label never the last line of a sheet").toBeLessThan(pages[label.page].length - 1);
    for (const row of rows) {
      const next = pages[row.page][row.at + 1];
      expect(next, `row on sheet ${row.page + 1} has its cells under it`).toBeDefined();
      expect(isRow(next), "next line is its cells, not another month").toBe(false);
    }
    const lines: { page: number; at: number }[] = [];
    pages.forEach((p, page) => p.forEach((text, at) => { if (/\d+ mes(es)? más, hasta el/.test(text)) lines.push({ page, at }); }));
    const last = rows[rows.length - 1];
    expect(lines, "exactly one «N meses más» line").toHaveLength(1);
    expect(lines[0].page, "the line on the sheet of the last row").toBe(last.page);
    expect(lines[0].at - last.at, "the line right behind the last row's cells").toBeGreaterThan(0);
    expect(lines[0].at - last.at).toBeLessThanOrEqual(3);
  });

// Empty: a goal with no tasks under the largest point leaves no sheet that carries only its name.
test("beyond the sweep: a goal with no tasks under 64 open tasks of another leaves no sheet carrying only its name", async ({ person, browser, baseURL, db }) => {
  const name = "Vacía";
  await seedFiller(db, person, 64);
  await seedMeasured(db, person, name, 12);
  const pages = await printedPages(browser, baseURL, person, "/exportar", "vacia", [name]);
  const lowered = name.toLowerCase();
  const withName = pages.filter((lines) => lines.includes(lowered));
  expect(withName.length, "the goal's name is printed").toBeGreaterThan(0);
  for (const lines of withName) expect(lines.length, `a sheet with only «${lowered}» and a line or two`).toBeGreaterThan(3);
  noSheetEndsOnALabel(pages, "empty goal");
});
