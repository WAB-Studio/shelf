import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// `ReporteImpresoTablaLarga.dc.html` (decision 3 of 2026-10-10, after the train-5 critic): a goal's «por mes» table of
// 15 printed rows or more (20 until the train-6 critic) starts on the page it reaches (its label on the goal's own page), breaks between rows only,
// repeats its head on every page it continues on, and keeps the months-left-out line with its last row. A table of fewer
// than 15 rows keeps label, table and line on one page. Every month is an offset from the real current month.
const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const labelOf = (offset: number) => `${NAMES[Number(startOf(offset).slice(5, 7)) - 1]} ${startOf(offset).slice(0, 4)}`;
const range = (count: number) => Array.from({ length: count }, (_, i) => i);

const A4 = { width: 794, height: 1123 };

// `measured`: a goal that measures Práctica in minutes with an amount in each month; else a goal with one task a month.
async function seed(
  db: postgres.Sql, person: Person, name: string, months: number, measured: boolean, extraTasks = 0,
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${startOf(months + 2)}::date,
            ${measured ? "Práctica" : null}, ${measured ? "minutos" : null},
            (${startOf(0)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id
  `;
  for (const offset of range(months)) {
    if (measured) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${startOf(offset)}::date, 600)
      `;
    } else {
      await db`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${person.id}, ${goal.id}, ${`Tarea ${offset}`}, ${startOf(offset)}::date)
      `;
    }
  }
  // Open tasks above the table move the page cut that falls inside it.
  for (const n of range(extraTasks)) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${goal.id}, ${`Tarea abierta ${n}`}, ${startOf(0)}::date)
    `;
  }
  return goal.id;
}

async function open(browser: Browser, baseURL: string, person: Person, name: string) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: A4 });
  const page = await context.newPage();
  await page.goto("/exportar");
  await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  return { context, page };
}

async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `tabla-larga-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

function pageLines(file: string): string[][] {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const count = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  return Array.from({ length: count }, (_, i) =>
    execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
      .toLowerCase()
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

// A header set in tracked capitals comes out of the PDF with a space between letters: «h e c h o».
const spaced = (word: string) => word.split("").join(" ?");

type Where = {
  pages: string[][];
  namePage: number;
  labelPage: number;
  labelAt: number;
  rows: { page: number; at: number }[];
};

function locate(file: string, name: string, months: number): Where {
  const pages = pageLines(file);
  const lowered = name.toLowerCase();
  const namePage = pages.findIndex((lines) => lines.includes(lowered));
  expect(namePage, `goal name in the PDF (${file})`).toBeGreaterThanOrEqual(0);
  const label = `${lowered} · por mes · ${months} meses`;
  const labelPage = pages.findIndex((lines) => lines.includes(label));
  expect(labelPage, `«${label}» in the PDF (${file})`).toBeGreaterThanOrEqual(0);
  const labelAt = pages[labelPage].indexOf(label);
  const rows = range(months).map((offset) => {
    const found: { page: number; at: number }[] = [];
    pages.forEach((lines, page) =>
      lines.forEach((line, at) => {
        // Another goal's table above this one prints the same months.
        const after = page > labelPage || (page === labelPage && at > labelAt);
        if (after && line.startsWith(labelOf(offset))) found.push({ page, at });
      }),
    );
    expect(found, `row ${labelOf(offset)} printed exactly once (${file})`).toHaveLength(1);
    return found[0];
  });
  return { pages, namePage, labelPage, labelAt, rows };
}

const remove = (db: postgres.Sql, person: Person, id: string) =>
  db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;

// Runs one goal through the printer; `check` reads where everything landed.
async function withGoal(
  ctx: { person: Person; browser: Browser; baseURL: string; db: postgres.Sql },
  spec: { months: number; measured: boolean; tag: string; tasks?: number },
  check: (where: Where, name: string) => void,
) {
  const name = `Inglés ${spec.tag} ${Date.now()}`;
  const id = await seed(ctx.db, ctx.person, name, spec.months, spec.measured, spec.tasks);
  const { context, page } = await open(ctx.browser, ctx.baseURL, ctx.person, name);
  try {
    const file = await printed(page, spec.tag);
    check(locate(file, name, spec.months), name);
  } finally {
    await context.close();
    await remove(ctx.db, ctx.person, id);
  }
}

test.describe("the paper report: a «por mes» table of 15 rows or more starts where it reaches and flows (RP-71, decision 3)", () => {
  // The board: 46 months of a measured goal.
  test("a 46-month table starts on the goal's own page, with rows under its label, not on a fresh page", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 46, measured: true, tag: "m46" }, (w) => {
      expect(w.labelPage, `label on page ${w.labelPage + 1}, the goal's name on page ${w.namePage + 1}`).toBe(w.namePage);
      const onLabelPage = w.rows.filter((row) => row.page === w.labelPage);
      expect(onLabelPage.length, "rows under the label before the first cut").toBeGreaterThanOrEqual(8);
      expect(w.rows[0].page, "first row with its label").toBe(w.labelPage);
      expect(w.rows[0].at).toBeGreaterThan(w.labelAt);
      expect(w.labelAt, "label never the last line of a page").toBeLessThan(w.pages[w.labelPage].length - 1);
    });
  });

  for (const tasks of range(8))
  test(`a 46-month table with ${tasks} open tasks above it breaks between rows: each row whole on one page, in order, none lost, over more than one page`, async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 46, measured: true, tag: `m46b${tasks}`, tasks }, (w) => {
      expect(new Set(w.rows.map((row) => row.page)).size, "table spans more than one page").toBeGreaterThan(1);
      w.rows.forEach((row, index) => {
        // The month's name prints on a line of its own and its cells on the next line of the same page.
        const next = w.pages[row.page][row.at + 1];
        expect(next, `row ${labelOf(index)} on page ${row.page + 1} has its cells under it`).toBeDefined();
        expect(next, `row ${labelOf(index)}: next line is its cells, not another month`).not.toMatch(
          new RegExp(`^(${NAMES.join("|")}) \\d{4}`),
        );
        if (index > 0) {
          const before = w.rows[index - 1];
          expect(row.page > before.page || (row.page === before.page && row.at > before.at), `order at ${labelOf(index)}`).toBe(true);
        }
      });
    });
  });

  test("a 46-month table repeats its head (MES / HECHO / PLANEADO) at the top of every page it continues on", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 46, measured: true, tag: "m46c" }, (w) => {
      const later = [...new Set(w.rows.map((row) => row.page))].filter((page) => page > w.labelPage);
      expect(later.length, "the table continues on a later page").toBeGreaterThan(0);
      for (const page of later) {
        const first = Math.min(...w.rows.filter((row) => row.page === page).map((row) => row.at));
        const above = w.pages[page].slice(0, first).join(" ");
        expect(above, `page ${page + 1} opens its rows with the head`).toMatch(new RegExp(`${spaced("mes")} ?${spaced("hecho")} ?${spaced("planeado")}`, "i"));
        expect(above, `page ${page + 1} head does not say «por mes»`).not.toMatch(new RegExp(`${spaced("por")} ?${spaced("mes")}`, "i"));
        expect(first, `page ${page + 1}: the head is the first thing above the rows`).toBeLessThanOrEqual(3);
      }
      expect(w.labelPage, "and the table begins on the goal's own page").toBe(w.namePage);
    });
  });

  test("a 46-month table keeps the months-left-out line with its last row, on the same page and after it", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 46, measured: true, tag: "m46d" }, (w) => {
      const last = w.rows[45];
      const line = w.pages[last.page].findIndex((text, at) => at > last.at && text.includes("sin monto"));
      expect(line, `«…: sin monto» on page ${last.page + 1}, where the last row is`).toBeGreaterThan(last.at);
      expect(w.labelPage, "and the table still starts on the goal's page").toBe(w.namePage);
    });
  });

  // Open tasks above the table slide the page cut along it; across enough of them the cut falls between the last row and the line.
  for (const tasks of range(26))
  test(`a 46-month table with ${tasks} open tasks above it never leaves the months-left-out line alone on a page`, async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL! , db }, { months: 46, measured: true, tag: `m46e${tasks}`, tasks }, (w) => {
      const last = w.rows[45];
      expect(
        w.pages[last.page].findIndex((text, at) => at > last.at && text.includes("sin monto")),
        `«…: sin monto» follows the last row on page ${last.page + 1}`,
      ).toBeGreaterThan(last.at);
    });
  });

  // The boundary: 14 printed rows keep today's whole block; 15 flow.
  test("14 printed rows stay whole: label, every row and the months-left-out line on one page", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 14, measured: true, tag: "m14" }, (w) => {
      expect(new Set(w.rows.map((row) => row.page)), "all 14 rows on one page").toEqual(new Set([w.labelPage]));
      expect(w.pages[w.labelPage].some((text) => text.includes("sin monto")), "months-left-out line on that page").toBe(true);
    });
  });

  test("15 printed rows flow: the label is on the goal's own page, not pushed to a new one", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 15, measured: true, tag: "m15" }, (w) => {
      expect(w.labelPage, `label on page ${w.labelPage + 1}, the goal's name on page ${w.namePage + 1}`).toBe(w.namePage);
      expect(w.rows[0].page, "label glued to its first row").toBe(w.labelPage);
    });
  });

  // A goal with no measure: MES / TAREAS / ESTADO.
  test("a no-measure goal of 22 months flows the same way: label on the goal's page, head TAREAS repeated, rows whole, line with the last row", async ({
    person, browser, baseURL, db,
  }) => {
    await withGoal({ person, browser, baseURL: baseURL!, db }, { months: 22, measured: false, tag: "s22" }, (w) => {
      expect(w.labelPage, `label on page ${w.labelPage + 1}, the goal's name on page ${w.namePage + 1}`).toBe(w.namePage);
      expect(w.rows[0].page).toBe(w.labelPage);
      const later = [...new Set(w.rows.map((row) => row.page))].filter((page) => page > w.labelPage);
      expect(later.length, "the table continues on a later page").toBeGreaterThan(0);
      for (const page of later) {
        const first = Math.min(...w.rows.filter((row) => row.page === page).map((row) => row.at));
        expect(w.pages[page].slice(0, first).join(" "), `page ${page + 1} repeats its head (MES / TAREAS / ESTADO)`).toMatch(
          new RegExp(`${spaced("mes")} ?${spaced("tareas")} ?${spaced("estado")}`, "i"),
        );
      }
      const last = w.rows[21];
      expect(
        w.pages[last.page].findIndex((text, at) => at > last.at && text.includes("sin tareas")),
        "«…: sin tareas» after the last row, on its page",
      ).toBeGreaterThan(last.at);
    });
  });

  test("a no-measure goal of 14 months stays whole on one page", async ({ person, browser, baseURL, db }) => {
    await withGoal({ person, browser, baseURL: baseURL! , db }, { months: 14, measured: false, tag: "s14" }, (w) => {
      expect(new Set(w.rows.map((row) => row.page))).toEqual(new Set([w.labelPage]));
      expect(w.pages[w.labelPage].some((text) => text.includes("sin tareas"))).toBe(true);
    });
  });
});

// Module 803 (decision of 2026-10-10, after the train-6 critic): a goal whose table prints whole keeps its head with it.
// Open tasks of a goal before it slide the page cut over the head; across enough of them it falls between head and label.
test.describe("the paper report: a goal whose table prints whole keeps its head with it when the goal fits a page (803)", () => {
  for (const months of [12, 16, 19])
  for (const above of range(months === 12 ? 40 : 24))
  test(`${months}-month goal under another goal's ${above} open tasks: its name is on the page of its «por mes» label`, async ({
    person, browser, baseURL, db,
  }) => {
    const [filler] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Previa ${Date.now()}`}, ${startOf(3)},
              (${startOf(0)}::date + interval '13 days' + interval '12 hours')::timestamptz)
      returning id
    `;
    for (const n of range(above)) {
      await db`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${person.id}, ${filler.id}, ${`Previa ${n}`}, ${startOf(0)}::date)
      `;
    }
    try {
      await withGoal({ person, browser, baseURL: baseURL!, db }, { months, measured: true, tag: `h${months}x${above}` }, (w) => {
        expect(w.labelPage, `label on page ${w.labelPage + 1}, the goal's name on page ${w.namePage + 1}`).toBe(w.namePage);
        expect(w.rows[0].page, "and its first row with the label").toBe(w.labelPage);
      });
    } finally {
      await remove(db, person, filler.id);
    }
  });
});
