import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

// `ReporteFilasSinMonto.dc.html` (RP-77, module 856): on screen a month not yet begun with no planned amount
// says «sin monto», and a goal measured in time with no rhythm names each month's tasks under its state, never
// «0 tareas»; a printed row carries its tasks too. Every month is an offset from the real current month.
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
const labelOf = (offset: number) => `${nameOf(offset)} ${startOf(offset).slice(0, 4)}`;
const yearName = (offset: number) => `${nameOf(offset)} de ${startOf(offset).slice(0, 4)}`;

type Spec = {
  name: string;
  measure?: string;
  unit?: string;
  last: number;
  budgets?: Record<number, number>;
  // offset -> tasks planned in that month.
  tasks?: Record<number, number>;
  rhythm?: number;
};

async function seed(db: postgres.Sql, person: Person, spec: Spec): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${spec.name}, ${startOf(spec.last + 1)}::date, ${spec.measure ?? null}, ${spec.unit ?? null},
            ${spec.rhythm ?? null}, ${`${todayInZone()}T12:00:00Z`}::timestamptz)
    returning id
  `;
  for (const [offset, amount] of Object.entries(spec.budgets ?? {})) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${startOf(Number(offset))}::date, ${amount})
    `;
  }
  for (const [key, count] of Object.entries(spec.tasks ?? {})) {
    for (let n = 1; n <= count; n++) {
      await db`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${person.id}, ${goal.id}, ${`Tarea ${key} ${n}`}, ${startOf(Number(key))}::date)
      `;
    }
  }
  return goal.id;
}

const remove = (db: postgres.Sql, person: Person, ids: string[]) =>
  db`delete from goals.goals where id = any(${ids}::uuid[]) and user_id = ${person.id}`;

const TIMED = { measure: "Práctica", unit: "minutos" };
// Time, no rhythm: current month 2 tasks, next 1, the one after none, the one after 1.
const portafolio = (name: string): Spec => ({ name, ...TIMED, last: 3, tasks: { 0: 2, 1: 1, 3: 1 } });

async function open(browser: Browser, baseURL: string, person: Person, name: string, width: number) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width < 700 ? 800 : 1000 },
  });
  const page = await context.newPage();
  await page.goto("/exportar");
  await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  return { context, page };
}

// The «por mes» section of one goal.
const sectionOf = (page: Page, name: string) =>
  page.locator("section").filter({ has: page.getByText(`${name} · por mes`, { exact: true }) });

// One visible row of a table, whichever face the width shows.
const rowOf = (section: Locator, offset: number) =>
  section.locator("li:visible, tbody tr:visible").filter({ hasText: new RegExp(labelOf(offset), "i") });

const linesOf = async (row: Locator) =>
  (await row.innerText()).toLowerCase().split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
const flatOf = async (row: Locator) => (await linesOf(row)).join(" ");

const FACES = [360, 1280];

const A4 = { width: 794, height: 1123 };
async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `rp77-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

// One goal's text on paper, from its «por mes» label to the next label (or the end), lowercase, one run.
function paperSection(file: string, name: string): string {
  const flat = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ").toLowerCase();
  const label = `${name} · por mes`.toLowerCase();
  const from = flat.indexOf(label);
  expect(from, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
  const to = flat.indexOf("· por mes", from + label.length);
  return flat.slice(from, to === -1 ? undefined : to);
}

test.describe("/exportar rows say «sin monto» and the month's tasks (RP-77)", () => {
  for (const width of FACES) {
    test(`a future month with tasks says «1 tarea» and «sin monto» at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Portafolio ${Date.now()}`;
      const id = await seed(db, person, portafolio(name));
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const text = await flatOf(rowOf(sectionOf(page, name), 1));
        expect(text).toContain("1 tarea");
        expect(text).not.toContain("1 tareas");
        expect(text).toContain("sin monto");
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });

    test(`a future month with no tasks says «sin monto» and never «0 tareas» at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Portafolio ${Date.now()}`;
      const id = await seed(db, person, portafolio(name));
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const text = await flatOf(rowOf(sectionOf(page, name), 2));
        expect(text).toContain("sin monto");
        expect(text).not.toContain("tarea");
        expect(text).not.toContain("0 tareas");
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });

    test(`the current month stacks «en curso» over «2 tareas», with no «·» at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Portafolio ${Date.now()}`;
      const id = await seed(db, person, portafolio(name));
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const lines = await linesOf(rowOf(sectionOf(page, name), 0));
        const at = lines.findIndex((line) => line === "en curso");
        expect(at, `«en curso» on a line of its own in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
        expect(lines[at + 1]).toBe("2 tareas");
        expect(lines.join(" ")).not.toContain("·");
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });

    test(`a month begun with no amount draws the done figure alone, no «sin monto» at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Portafolio ${Date.now()}`;
      const id = await seed(db, person, portafolio(name));
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const text = await flatOf(rowOf(sectionOf(page, name), 0));
        expect(text).not.toContain("sin monto");
        expect(text).toMatch(/\b0\s*min/);
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });
  }

  for (const width of FACES) {
    test(`another unit says «sin monto» in a future month and names no task at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Correr ${Date.now()}`;
      const id = await seed(db, person, { name, measure: "distancia", unit: "km", last: 3, budgets: { 0: 40 }, tasks: { 1: 2 } });
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const section = sectionOf(page, name);
        for (const offset of [1, 2]) {
          const text = await flatOf(rowOf(section, offset));
          expect(text, `month +${offset}`).toContain("sin monto");
          expect(text, `month +${offset}`).not.toContain("tarea");
        }
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });

    test(`a time goal with a rhythm names no task in any row at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Inglés ${Date.now()}`;
      const id = await seed(db, person, { name, ...TIMED, last: 2, rhythm: 600, tasks: { 1: 1 } });
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const section = sectionOf(page, name);
        for (const offset of [0, 1, 2]) expect(await flatOf(rowOf(section, offset)), `month +${offset}`).not.toContain("tarea");
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });

    test(`a month with an amount keeps it and does not say «sin monto» at ${width}`, async ({ person, browser, baseURL, db }) => {
      const name = `Vocabulario ${Date.now()}`;
      const id = await seed(db, person, { name, measure: "búsquedas", unit: "búsquedas", last: 2, budgets: { 0: 60, 1: 80 } });
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        const text = await flatOf(rowOf(sectionOf(page, name), 1));
        expect(text).toMatch(/80\s*búsquedas/);
        // The wide face says «planeado» once, in the header.
        if (width < 700) expect(text).toContain("planeado");
        expect(text).not.toContain("sin monto");
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });
  }

  // On the 1st every rhythm of 1 or more plans at least a day, so no share rounds to 0.
  const today = todayInZone();
  const length = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const zeroRhythm = Math.ceil(length / (length - Number(today.slice(8, 10)) + 1)) - 1;
  test("a share that rounds to 0 keeps what 844 drew: the reached figure alone", async ({ person, browser, baseURL, db }) => {
    test.skip(zeroRhythm < 1, "no rhythm rounds to a 0 share today");
    const name = `Cero ${Date.now()}`;
    const id = await seed(db, person, { name, measure: "minutos", unit: "minutos", last: 1, rhythm: zeroRhythm });
    const { context, page } = await open(browser, baseURL!, person, name, 1280);
    try {
      const text = await flatOf(rowOf(sectionOf(page, name), 0));
      expect(text).not.toContain("sin monto");
      expect(text).not.toMatch(/de 0/);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("on paper the printed current row carries its tasks", async ({ person, browser, baseURL, db }) => {
    const name = `Portafolio ${Date.now()}`;
    const id = await seed(db, person, portafolio(name));
    const { context, page } = await open(browser, baseURL!, person, name, A4.width);
    try {
      const section = paperSection(await printed(page, "fila"), name);
      const from = section.indexOf(labelOf(0));
      expect(from, "the current month's row on paper").toBeGreaterThanOrEqual(0);
      const to = section.indexOf(yearName(1), from);
      expect(section.slice(from, to === -1 ? undefined : to)).toContain("2 tareas");
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("on paper the left-out line is unchanged and an unprinted row's «sin monto» does not show", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Portafolio ${Date.now()}`;
    const id = await seed(db, person, portafolio(name));
    const { context, page } = await open(browser, baseURL!, person, name, A4.width);
    try {
      const section = paperSection(await printed(page, "fuera"), name);
      expect(section).toContain(`${yearName(1)} y ${yearName(3)}: sin monto · 1 tarea`);
      expect(section).toContain(`${yearName(2)}: sin monto`);
      expect(section.match(/sin monto/g) ?? []).toHaveLength(2);
      for (const offset of [1, 2, 3]) expect(section, `row ${labelOf(offset)} not printed`).not.toContain(labelOf(offset));
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  for (const width of [360, 1024, 1440]) {
    test(`nothing leaves its row and the page does not scroll sideways at ${width}`, async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      const name = `Portafolio ${stamp}`;
      // A time note that must stay whole beside its tasks: «de 9999 h 59 min».
      const long = `Intensivo ${stamp}`;
      const ids = [
        await seed(db, person, portafolio(name)),
        await seed(db, person, { name: long, ...TIMED, last: 2, budgets: { 0: 599999, 1: 599999 }, tasks: { 0: 2, 1: 1 } }),
      ];
      const { context, page } = await open(browser, baseURL!, person, name, width);
      try {
        for (const [goal, offsets] of [[name, [0, 1, 2, 3]], [long, [0, 1]]] as const) {
          const section = sectionOf(page, goal);
          for (const offset of offsets) {
            const spill = await rowOf(section, offset).evaluate((row) => {
              const box = row.getBoundingClientRect();
              return [...row.querySelectorAll("*")]
                .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > box.right + 1)
                .map((el) => el.className || el.tagName);
            });
            expect(spill, `${goal} month +${offset} spills`).toEqual([]);
          }
        }
        // A time note never splits: its text sits on one line, whatever the label beside it holds.
        for (const offset of width === 360 ? [0, 1] : []) {
          const lines = await rowOf(sectionOf(page, long), offset).evaluate((row) => {
            const note = [...row.children].at(-1);
            if (!note || row.tagName !== "LI") return 1;
            const style = getComputedStyle(note);
            const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
            return Math.round(note.getBoundingClientRect().height / line);
          });
          expect(lines, `${long} month +${offset} note lines`).toBe(1);
        }
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(wide, "sideways scroll").toBeLessThanOrEqual(0);
      } finally {
        await context.close();
        await remove(db, person, ids);
      }
    });
  }

  test("a goal with no measure keeps its task table on paper: its own counts, no «sin monto»", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza ${Date.now()}`;
    const id = await seed(db, person, { name, last: 3, tasks: { 0: 1, 1: 1 } });
    const { context, page } = await open(browser, baseURL!, person, name, A4.width);
    try {
      const section = paperSection(await printed(page, "sinmedida"), name);
      expect(section).toContain("0 de 1 hechas");
      expect(section).toContain("1 por hacer");
      expect(section).toContain(`${yearName(2)} y ${yearName(3)}: sin tareas`);
      expect(section).not.toContain("sin monto");
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });
});
