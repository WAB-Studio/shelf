import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// Decisions of 2026-10-10 on the paper report, after the train-4 critic:
//  (1) the months a paper leaves out always carry their year («diciembre 2026, enero 2027 y febrero 2027: sin monto»);
//  (2) a goal's «por mes» label, its table and its months-left-out line stay on one page, whatever came before;
//  (3) a table longer than a page still breaks.
// Every month is an offset from the real current month, so no assertion depends on the day it runs.
const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const nameOf = (offset: number) => NAMES[Number(startOf(offset).slice(5, 7)) - 1];
const yearOf = (offset: number) => startOf(offset).slice(0, 4);
const labelOf = (offset: number) => `${nameOf(offset)} ${yearOf(offset)}`;
const withYear = (offset: number) => `${nameOf(offset)} ${yearOf(offset)}`;

function listed(items: string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

const A4 = { width: 794, height: 1123 };

async function seedGoal(
  db: postgres.Sql,
  person: Person,
  spec: { name: string; from: number; to: number; budgets: number[]; tasks: number },
): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${spec.name}, ${startOf(spec.to + 1)}::date, 'distancia', 'km',
            (${startOf(spec.from)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id
  `;
  for (const offset of spec.budgets) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${startOf(offset)}::date, 40)
    `;
  }
  for (let n = 1; n <= spec.tasks; n++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${goal.id}, ${`Tarea ${n}`}, ${startOf(0)}::date)
    `;
  }
  return goal.id;
}

async function open(browser: Browser, baseURL: string, person: Person) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: A4 });
  const page = await context.newPage();
  await page.goto("/exportar");
  return { context, page };
}

async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `papel-ano-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

// Each page as lowercase text, one run, and as its lines.
function pagesOf(file: string): { flat: string; lines: string[] }[] {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const count = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  return Array.from({ length: count }, (_, i) => {
    const text = execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], {
      encoding: "utf8",
    }).toLowerCase();
    const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    return { flat: lines.join(" "), lines };
  });
}

const remove = (db: postgres.Sql, person: Person, ids: string[]) =>
  db`delete from goals.goals where id = any(${ids}::uuid[]) and user_id = ${person.id}`;

// Dec of this or the coming year: out months are Dec, Jan, Feb, so every year boundary is crossed whatever today is.
const DEC = Number(startOf(0).slice(5, 7)) === 12 ? 12 : 12 - Number(startOf(0).slice(5, 7));
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

test.describe("the paper report: months out carry their year, and each goal's block stays whole", () => {
  test("clause 1: a goal that crosses a year names every month left out with its year, lowercase, no range, no count", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Cruce ${Date.now()}`;
    // Printed: this month up to the month before December; out: December, January, February.
    const id = await seedGoal(db, person, {
      name, from: 0, to: DEC + 2, budgets: range(0, DEC - 1), tasks: 0,
    });
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const pages = pagesOf(await printed(page, "cruce"));
      const flat = pages.map((p) => p.flat).join(" ");
      const at = flat.indexOf(`${name} · por mes`.toLowerCase());
      expect(at).toBeGreaterThanOrEqual(0);
      const section = flat.slice(at);
      const expected = `${listed([withYear(DEC), withYear(DEC + 1), withYear(DEC + 2)])}: sin monto`;
      expect(section).toContain(expected);
      // The two Decembers of a goal never read alike: every name in the line is followed by its year.
      const line = /([^.]*?): sin monto/.exec(section.slice(section.indexOf(nameOf(DEC)) - 1))?.[0] ?? "";
      for (const month of line.match(new RegExp(NAMES.join("|"), "g")) ?? []) {
        expect(line, `«${month}» without a year`).toMatch(new RegExp(`${month} de \\d{4}`));
      }
      expect(line).not.toMatch(/ a |–|\d+ meses/);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 1: a single month out reads «<mes> de <año>: sin monto»", async ({ person, browser, baseURL, db }) => {
    const name = `Uno ${Date.now()}`;
    const id = await seedGoal(db, person, { name, from: 0, to: 1, budgets: [0], tasks: 0 });
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const flat = pagesOf(await printed(page, "uno")).map((p) => p.flat).join(" ");
      expect(flat).toContain(`${withYear(1)}: sin monto`);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  // The critic's sweep: k tasks in the first goal moves every page cut that follows it.
  // Two shapes: a two-row table, and a one-row table whose line is the longest part of the block.
  for (const printedRows of [[-1, 0], [0]])
  for (let k = 0; k <= 12; k++) {
    test(`clause 2: ${printedRows.length} printed row(s), with ${k} tasks in the first goal, each «por mes» block (label, rows, months-out line) is on one page and no page opens with «…: sin monto»`, async ({
      person, browser, baseURL, db,
    }) => {
      const stamp = Date.now();
      const names = ["A", "B", "C", "D", "E"].map((letter) => `Meta ${letter} ${stamp}`);
      const ids: string[] = [];
      for (const [i, name] of names.entries()) {
        // Printed: last month and this one; out: the next four, so the line is long enough to wrap.
        ids.push(await seedGoal(db, person, { name, from: printedRows[0], to: 4, budgets: printedRows, tasks: i === 0 ? k : 3 }));
      }
      const { context, page } = await open(browser, baseURL!, person);
      try {
        await expect(page.getByRole("main").getByText(names[0], { exact: true }).first()).toBeVisible();
        const pages = pagesOf(await printed(page, `k${k}`));

        for (const [n, p] of pages.entries()) {
          expect(p.lines[0], `page ${n + 1} must not open with the months-out line`).not.toMatch(/: sin monto$/);
          if (p.lines.length === 1) expect(p.lines[0], `page ${n + 1} is not a lone line`).not.toMatch(/sin monto/);
        }

        for (const name of names) {
          const label = `${name} · por mes`.toLowerCase();
          const holder = pages.filter((p) => p.flat.includes(label));
          expect(holder, `label of ${name} on exactly one page`).toHaveLength(1);
          const flat = holder[0].flat;
          const after = flat.slice(flat.indexOf(label));
          const block = after.includes("· por mes", label.length) ? after.slice(0, after.indexOf("· por mes", label.length)) : after;
          for (const offset of printedRows) expect(block, `${name}: rows`).toContain(labelOf(offset));
          expect(block, `${name}: months-out line on the label's page`).toContain(": sin monto");
        }
      } finally {
        await context.close();
        await remove(db, person, ids);
      }
    });
  }

  test("clause 3: a table longer than a page still breaks: every row prints, over more than one page", async ({
    person, browser, baseURL, db,
  }) => {
    // A goal with an end folds past 12 months (RP-115): the long table is its months set by hand, all but the last.
    const name = `Larga ${Date.now()}`;
    const id = await seedGoal(db, person, { name, from: 0, to: 59, budgets: range(0, 58), tasks: 0 });
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const pages = pagesOf(await printed(page, "larga"));
      const withRows = pages.filter((p) => range(0, 58).some((o) => p.flat.includes(labelOf(o))));
      expect(withRows.length, "the rows run over more than one page").toBeGreaterThan(1);
      const flat = pages.map((p) => p.flat).join(" ");
      for (const offset of range(0, 58)) expect(flat, `row ${labelOf(offset)}`).toContain(labelOf(offset));
      // The label stays with the first rows.
      const holder = pages.find((p) => p.flat.includes(`${name} · por mes`.toLowerCase()))!;
      expect(range(0, 58).some((o) => holder.flat.includes(labelOf(o))), "label shares a page with rows").toBe(true);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });
});
