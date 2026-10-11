import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// `ReporteImpresoMesesFuera.dc.html` (RP-71): on paper, under a goal's «por mes» table, one line names the
// months the table leaves out; the count counts the printed months; the screen keeps every month and says nothing.
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
const labelOf = (offset: number) => `${nameOf(offset)} ${startOf(offset).slice(0, 4)}`;
// The line names every month with its year (decision 2026-10-10).
const yearName = (offset: number) => `${nameOf(offset)} de ${startOf(offset).slice(0, 4)}`;

type Spec = {
  name: string;
  measure: string;
  unit: string;
  from: number;
  to: number;
  // offset -> amount; an offset absent has no budget row.
  budgets: Record<number, number>;
  // offset -> tasks planned in that month.
  tasks?: Record<number, number>;
  rhythm?: number;
};

async function seed(db: postgres.Sql, person: Person, spec: Spec): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${spec.name}, ${startOf(spec.to + 1)}::date, ${spec.measure}, ${spec.unit}, ${spec.rhythm ?? null},
            (${startOf(spec.from)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id
  `;
  for (const [offset, amount] of Object.entries(spec.budgets)) {
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

async function open(browser: Browser, baseURL: string, person: Person, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport });
  const page = await context.newPage();
  await page.goto("/exportar");
  return { context, page };
}

const A4 = { width: 794, height: 1123 };
const PHONE = { width: 390, height: 844 };

async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `rp71-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

// One goal's text on paper, from its «por mes» label to the next label (or the end), lowercase, one run.
function sectionOf(file: string, name: string): string {
  const flat = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" })
    .replace(/\s+/g, " ")
    .toLowerCase();
  const label = `${name} · por mes`.toLowerCase();
  const from = flat.indexOf(label);
  expect(from, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
  const to = flat.indexOf("· por mes", from + label.length);
  return flat.slice(from, to === -1 ? undefined : to);
}

// A month named in the line reads «mes,», «mes y» or «mes:» — its table row always carries the year after it.
const named = (section: string, offset: number) => new RegExp(`${nameOf(offset)}(?:,| y |:)`).test(section);

const listed = (items: string[]) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;

// A time goal with no rhythm: its tasks are what a not-started month holds (RP-75, board ReporteImpresoTareasFuera).
const TIMED = { measure: "Práctica", unit: "minutos" };

const countOf = (text: string) => /(\d+) mes(?:es)?\b/.exec(text)?.[0];

const remove = (db: postgres.Sql, person: Person, id: string) =>
  db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;

// Two out (+1, +2): «a y b».
const TWO: Omit<Spec, "name"> = { measure: "km", unit: "km", from: -2, to: 2, budgets: { [-2]: 40, [-1]: 40, 0: 40 } };

test.describe("the paper names the months it leaves out (RP-71)", () => {
  test("clause 1, two out: «noviembre y diciembre: sin monto» sits under the table on paper", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Correr dos ${Date.now()}`;
    const id = await seed(db, person, { ...TWO, name });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "dos"), name);
      expect(section).toContain(`${yearName(1)} y ${yearName(2)}: sin monto`);
      for (const offset of [-2, -1, 0]) expect(named(section, offset), `printed month ${offset} not named`).toBe(false);
      // The line is the table's, so it comes after the last printed row.
      expect(section.indexOf(": sin monto")).toBeGreaterThan(section.indexOf(labelOf(0)));
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("clause 1, one out: «diciembre: sin monto», and a future month planned at 0 is not named", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Correr uno ${Date.now()}`;
    // +1 carries an amount of 0 (an amount, so it prints); only +2 is out.
    const id = await seed(db, person, { name, measure: "km", unit: "km", from: 0, to: 2, budgets: { 0: 40, 1: 0 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "uno"), name);
      expect(section).toContain(`${yearName(2)}: sin monto`);
      expect(section).not.toContain(`${yearName(1)} y ${yearName(2)}`);
      expect(named(section, 0), "the current month not named").toBe(false);
      expect(named(section, 1), "a month planned at 0 not named").toBe(false);
      expect(section).not.toContain(`${yearName(1)}: sin monto`);
      expect(section.match(/sin monto/g) ?? []).toHaveLength(1);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("clause 1, three out: «a, b y c: sin monto»; a closed month without amount is not named", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Correr tres ${Date.now()}`;
    // -2 and -1 are closed with no amount: they print as «cerrado», so they are not in the line.
    const id = await seed(db, person, { name, measure: "km", unit: "km", from: -2, to: 3, budgets: { 0: 40 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "tres"), name);
      expect(section).toContain(`${yearName(1)}, ${yearName(2)} y ${yearName(3)}: sin monto`);
      for (const offset of [-2, -1, 0]) expect(named(section, offset), `printed month ${offset} not named`).toBe(false);
      expect(section.match(/sin monto/g) ?? []).toHaveLength(1);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("clause 2: when no month is missing the line does not exist", async ({ person, browser, baseURL, db }) => {
    const name = `Correr completo ${Date.now()}`;
    const id = await seed(db, person, {
      name, measure: "km", unit: "km", from: -1, to: 1, budgets: { [-1]: 40, 0: 40, 1: 40 },
    });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "completo"), name);
      for (const offset of [-1, 0, 1]) expect(section, `month ${offset} printed`).toContain(labelOf(offset));
      expect(section).not.toContain("sin monto");
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("clause 1 in the print DOM: the line is visible, whole and below the table", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Correr dom ${Date.now()}`;
    const id = await seed(db, person, { ...TWO, name });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      await page.emulateMedia({ media: "print" });
      const section = page.locator("section").filter({ hasText: `${name} · por mes` }).last();
      const line = section.getByText(`${yearName(1)} y ${yearName(2)}: sin monto`, { exact: true }).locator("visible=true");
      await expect(line).toHaveCount(1);
      const grid = section.locator("table").locator("visible=true").first();
      const table = await grid.boundingBox();
      const lastMonth = await grid.locator("tbody tr:not([data-row='months-out']):not([data-unprinted])").last().boundingBox();
      const at = await line.boundingBox();
      expect(at!.y, "the line sits under the last month row").toBeGreaterThanOrEqual(lastMonth!.y + lastMonth!.height - 1);
      expect(at!.y + at!.height, "and at the end of the table").toBeLessThanOrEqual(table!.y + table!.height + 1);
      await expect(grid.locator("tbody tr[data-row='months-out']"), "in the table's last row").toHaveCount(1);
      // Body text, not the quiet note: the body-line size token, in the sans family.
      const look = await line.evaluate((node) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--pulsar-text-line-size)";
        document.body.append(probe);
        const wanted = getComputedStyle(probe).fontSize;
        probe.remove();
        const style = getComputedStyle(node);
        return { size: style.fontSize, wanted, family: style.fontFamily };
      });
      expect(look.size, "the line is set at the body-line size").toBe(look.wanted);
      expect(look.family).not.toMatch(/mono/i);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("clause 3: on paper the table counts the printed months: 3 of 5, 3 of 6", async ({
    person, browser, baseURL, db,
  }) => {
    const stamp = Date.now();
    const five = `Correr cinco ${stamp}`;
    const six = `Correr seis ${stamp}`;
    const ids = [
      await seed(db, person, { ...TWO, name: five }),
      await seed(db, person, { name: six, measure: "km", unit: "km", from: -2, to: 3, budgets: { 0: 40 } }),
    ];
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(five, { exact: true }).first()).toBeVisible();
      const file = await printed(page, "conteo");
      expect(countOf(sectionOf(file, five)), "5 months, 2 out").toBe("3 meses");
      expect(countOf(sectionOf(file, six)), "6 months, 3 out").toBe("3 meses");
    } finally {
      await context.close();
      for (const goalId of ids) await remove(db, person, goalId);
    }
  });

  test("clause 3: one printed month reads «1 mes»", async ({ person, browser, baseURL, db }) => {
    const name = `Correr singular ${Date.now()}`;
    const id = await seed(db, person, { name, measure: "km", unit: "km", from: 0, to: 1, budgets: { 0: 40 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      expect(countOf(sectionOf(await printed(page, "singular"), name))).toBe("1 mes");
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  for (const viewport of [{ width: 1440, height: 900 }, PHONE]) {
    test(`clause 4 on screen at ${viewport.width} px: every month, the count of all, and no line of months left out`, async ({
      person, browser, baseURL, db,
    }) => {
      const name = `Correr pantalla ${Date.now()}`;
      const id = await seed(db, person, { ...TWO, name });
      const { context, page } = await open(browser, baseURL!, person, viewport);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = page.locator("section").filter({ hasText: `${name} · por mes` }).last();
        for (const offset of [-2, -1, 0, 1, 2]) {
          await expect(section.getByText(labelOf(offset)).locator("visible=true"), `month ${offset}`).toHaveCount(1);
        }
        // The phone face shows the caption; the wide one keeps it for the screen reader.
        expect(await section.getByText("5 meses", { exact: true }).count(), "the count of all five").toBeGreaterThan(0);
        await expect(section.getByText("3 meses", { exact: true }).locator("visible=true"), "never the printed count").toHaveCount(0);
        await expect(page.getByText(/: sin monto$/).locator("visible=true")).toHaveCount(0);
      } finally {
        await context.close();
        await remove(db, person, id);
      }
    });
  }

  for (const viewport of [PHONE, { width: 1440, height: 900 }]) {
    test(`clause 5 on screen at ${viewport.width} px: «mide Práctica, en horas y minutos» and «mide distancia, en km»`, async ({
      person, browser, baseURL, db,
    }) => {
      const stamp = Date.now();
      const time = `Práctica meta ${stamp}`;
      const km = `Distancia meta ${stamp}`;
      const ids = [
        await seed(db, person, { name: time, measure: "Práctica", unit: "minutos", from: 0, to: 2, budgets: { 0: 600 } }),
        await seed(db, person, { name: km, measure: "distancia", unit: "km", from: 0, to: 2, budgets: { 0: 40 } }),
      ];
      const { context, page } = await open(browser, baseURL!, person, viewport);
      try {
        await expect(page.getByRole("main").getByText(time, { exact: true }).first()).toBeVisible();
        await expect(page.getByText(/^mide Práctica, en horas y minutos · hasta el \d/).locator("visible=true")).toHaveCount(1);
        await expect(page.getByText(/^mide distancia, en km · hasta el \d/).locator("visible=true")).toHaveCount(1);
        await expect(page.getByText(/^mide Práctica ·/)).toHaveCount(0);
      } finally {
        await context.close();
        for (const goalId of ids) await remove(db, person, goalId);
      }
    });
  }

  test("clause 5 on paper: the measure line carries name and unit", async ({ person, browser, baseURL, db }) => {
    const stamp = Date.now();
    const time = `Práctica papel ${stamp}`;
    const km = `Distancia papel ${stamp}`;
    const ids = [
      await seed(db, person, { name: time, measure: "Práctica", unit: "minutos", from: 0, to: 2, budgets: { 0: 600 } }),
      await seed(db, person, { name: km, measure: "distancia", unit: "km", from: 0, to: 2, budgets: { 0: 40 } }),
    ];
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(time, { exact: true }).first()).toBeVisible();
      const flat = execFileSync("pdftotext", ["-layout", await printed(page, "medida"), "-"], { encoding: "utf8" })
        .replace(/\s+/g, " ");
      expect(flat).toMatch(/mide Práctica, en horas y minutos · hasta el \d/);
      expect(flat).toMatch(/mide distancia, en km · hasta el \d/);
    } finally {
      await context.close();
      for (const goalId of ids) await remove(db, person, goalId);
    }
  });
});

test.describe("a time goal with no rhythm says its left-out months' tasks (835, RP-75)", () => {
  test("months with tasks group by count: «nov y ene: sin monto · 1 tarea», «dic: sin monto» alone", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Portafolio ${Date.now()}`;
    const id = await seed(db, person, { name, ...TIMED, from: 0, to: 3, budgets: {}, tasks: { 1: 1, 3: 1 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "tareas"), name);
      expect(section).toContain(`${yearName(1)} y ${yearName(3)}: sin monto · 1 tarea`);
      expect(section).toContain(`${yearName(2)}: sin monto`);
      expect(section).not.toContain(`${yearName(2)}: sin monto ·`);
      expect(section).not.toContain("0 tareas");
      // The months with a task are in the line, never printed as table rows.
      expect(section).not.toContain(labelOf(1));
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("two tasks read «2 tareas», in their own group", async ({ person, browser, baseURL, db }) => {
    const name = `Portafolio dos ${Date.now()}`;
    const id = await seed(db, person, { name, ...TIMED, from: 0, to: 2, budgets: {}, tasks: { 1: 2, 2: 1 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "dos-tareas"), name);
      expect(section).toContain(`${yearName(1)}: sin monto · 2 tareas`);
      expect(section).toContain(`${yearName(2)}: sin monto · 1 tarea`);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("13 months out, one with a task: the line sits whole on the table's page", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Certificacion ${Date.now()}`;
    const id = await seed(db, person, { name, ...TIMED, from: 0, to: 13, budgets: {}, tasks: { 5: 1 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const file = await printed(page, "certificacion");
      const bare = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13].map(yearName);
      const lines = [`${listed(bare)}: sin monto`, `${yearName(5)}: sin monto · 1 tarea`];
      const pages = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" })
        .split("\f")
        .map((text) => text.replace(/\s+/g, " ").toLowerCase());
      const head = pages.findIndex((text) => text.includes(`${name} · por mes`.toLowerCase()));
      expect(head, "the goal's table in the PDF").toBeGreaterThanOrEqual(0);
      for (const line of lines) expect(pages[head], line).toContain(line);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("a goal with a rhythm names no task: every month has an amount, so no line", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Ingles ${Date.now()}`;
    const id = await seed(db, person, { name, ...TIMED, from: 0, to: 2, budgets: {}, rhythm: 600, tasks: { 1: 1 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "ritmo"), name);
      expect(section).not.toContain("tarea");
      expect(section).not.toContain("sin monto");
      expect(section).toContain(labelOf(1));
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("another unit keeps «…: sin monto» and names no task", async ({ person, browser, baseURL, db }) => {
    const name = `Correr tareas ${Date.now()}`;
    const id = await seed(db, person, { name, measure: "km", unit: "km", from: 0, to: 2, budgets: { 0: 40 }, tasks: { 1: 1 } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const section = sectionOf(await printed(page, "km-tareas"), name);
      expect(section).toContain(`${yearName(1)} y ${yearName(2)}: sin monto`);
      expect(section).not.toContain("sin monto ·");
      expect(section).not.toContain("tarea ");
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });

  test("on screen the line does not exist", async ({ person, browser, baseURL, db }) => {
    const name = `Portafolio pantalla ${Date.now()}`;
    const id = await seed(db, person, { name, ...TIMED, from: 0, to: 3, budgets: {}, tasks: { 1: 1, 3: 1 } });
    const { context, page } = await open(browser, baseURL!, person, { width: 1440, height: 900 });
    try {
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/: sin monto/).locator("visible=true")).toHaveCount(0);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });
});
