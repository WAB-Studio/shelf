import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// `ReporteImpresoSinMedida.dc.html` (RP-71, decision 4 of 2026-10-10): on paper, a goal that measures nothing prints
// its months like a measured one: «<META> · POR MES · N MESES», a MES / TAREAS / ESTADO table of its tasks, and under
// it «…: sin tareas» naming, with their year, the months not started that hold no task. The screen keeps its own.
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
// «31 de enero de 2027»: the last day of a goal whose span ends at month `to`.
const lastDay = (to: number) => {
  const date = civilDateToDate(startOf(to + 1));
  date.setUTCDate(date.getUTCDate() - 1);
  const day = dateToCivilDate(date);
  return `${Number(day.slice(8, 10))} de ${NAMES[Number(day.slice(5, 7)) - 1]} de ${day.slice(0, 4)}`;
};
const listed = (items: string[]) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
const plus = (day: string, days: number) => {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
};

const A4 = { width: 794, height: 1123 };
const PHONE = { width: 360, height: 740 };
const WIDE = { width: 1440, height: 900 };

type Spec = {
  name: string;
  from: number;
  to: number;
  // offset -> tasks planned in that month, and how many of them are done.
  tasks: Record<number, { total: number; done: number }>;
  // A measured goal: its unit and the offsets that carry an amount.
  measured?: { unit: string; budgets: number[] };
};

async function seed(db: postgres.Sql, person: Person, spec: Spec): Promise<string> {
  const unit = spec.measured?.unit ?? null;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${spec.name}, ${startOf(spec.to + 1)}::date, ${unit}, ${unit},
            (${startOf(spec.from)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id
  `;
  for (const offset of spec.measured?.budgets ?? []) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${startOf(offset)}::date, 40)
    `;
  }
  for (const [key, { total, done }] of Object.entries(spec.tasks)) {
    const offset = Number(key);
    for (let n = 1; n <= total; n++) {
      const [task] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${person.id}, ${goal.id}, ${`Tarea ${offset} ${n}`}, ${startOf(offset)}::date)
        returning id
      `;
      if (n <= done) {
        const day = offset < 0 ? plus(startOf(offset), 19) : todayInZone();
        await db`
          insert into goals.facts (user_id, goal_id, one_off_id, day)
          values (${person.id}, ${goal.id}, ${task.id}, ${day}::date)
        `;
      }
    }
  }
  return goal.id;
}

async function open(browser: Browser, baseURL: string, person: Person, viewport: { width: number; height: number }, path = "/exportar") {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport });
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `sin-medida-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

// Each page as lowercase text in one run.
function pagesOf(file: string): string[] {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const count = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  return Array.from({ length: count }, (_, i) =>
    execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim(),
  );
}

// One goal's block on paper: from its «por mes» label to the next goal (the next label or its measure line).
function sectionOf(file: string, name: string): string {
  const flat = pagesOf(file).join(" ");
  const label = `${name} · por mes`.toLowerCase();
  const from = flat.indexOf(label);
  expect(from, `«${name} · por mes» in the PDF`).toBeGreaterThanOrEqual(0);
  const rest = flat.slice(from + label.length);
  const cut = rest.search(/· por mes| no mide nada| mide /);
  return flat.slice(from, cut === -1 ? undefined : from + label.length + cut);
}

// A header set in tracked capitals comes out of the PDF with a space between letters: «h e c h o».
const spaced = (word: string) => word.split("").join(" ?");
const header = (word: string) => new RegExp(`\\b${spaced(word)}\\b`);

const remove = (db: postgres.Sql, person: Person, ids: string[]) =>
  db`delete from goals.goals where id = any(${ids}::uuid[]) and user_id = ${person.id}`;

const waitFor = async (page: Page, name: string) =>
  expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();

// The board: September 3 of 3, this month 2 of 4, next month 1 to do, the two after it empty.
const BOARD = (name: string): Spec => ({
  name, from: -1, to: 3, tasks: { [-1]: { total: 3, done: 3 }, 0: { total: 4, done: 2 }, 1: { total: 1, done: 0 } },
});

test.describe("the paper report prints the months of a goal that measures nothing (RP-71)", () => {
  test("clause 1: name, «no mide nada · hasta el …», then «<META> · por mes · N meses» with N the printed months, in that order", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const flat = pagesOf(await printed(page, "rotulo")).join(" ");
      const at = flat.indexOf(name.toLowerCase());
      const measure = `no mide nada · hasta el ${lastDay(3)}`;
      const label = `${name} · por mes · 3 meses`.toLowerCase();
      expect(flat.indexOf(measure, at), "measure line follows the name").toBeGreaterThan(at);
      expect(flat.indexOf(label), "the label counts 3 printed months of 5").toBeGreaterThan(flat.indexOf(measure));
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 1: the count follows the printed months: one printed month reads «1 mes»", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Una sola ${Date.now()}`;
    const id = await seed(db, person, { name, from: 0, to: 2, tasks: { 0: { total: 2, done: 1 } } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const flat = pagesOf(await printed(page, "singular")).join(" ");
      expect(flat).toContain(`${name} · por mes · 1 mes`.toLowerCase());
      expect(flat).not.toContain(`${name} · por mes · 3 meses`.toLowerCase());
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 2: the table is MES / TAREAS / ESTADO, «N de M hechas» in a started month, «N por hacer» in one to come", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza tabla ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "tabla"), name);
      expect(section).toMatch(new RegExp(`${spaced("mes")} ?${spaced("tareas")} ?${spaced("estado")}`, "i"));
      expect(section).not.toMatch(new RegExp(`${spaced("por")} ?${spaced("mes")} ?${spaced("tareas")}`, "i"));
      expect(section).not.toMatch(header("hecho"));
      expect(section).toContain(`${labelOf(-1)} 3 de 3 hechas cerrado`);
      expect(section).toContain(`${labelOf(0)} 2 de 4 hechas en curso`);
      expect(section).toContain(`${labelOf(1)} 1 por hacer por venir`);
      expect(section, "a month to come never reads «hechas»").not.toContain(`${labelOf(1)} 0 de`);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 2: the numbers are the goal's own: 0 of 2, 5 of 5 and 3 to do read as seeded", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Otras cifras ${Date.now()}`;
    const id = await seed(db, person, {
      name, from: -1, to: 2, tasks: { [-1]: { total: 2, done: 0 }, 0: { total: 5, done: 5 }, 1: { total: 3, done: 0 } },
    });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "cifras"), name);
      // September's two undone tasks ride into this month, so the screen's own count decides this month's M.
      expect(section).toContain(`${labelOf(-1)} 0 de 2 hechas cerrado`);
      expect(section).toMatch(new RegExp(`${labelOf(0)} 5 de (\\d+) hechas en curso`));
      expect(section).toContain(`${labelOf(1)} 3 por hacer por venir`);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 2: M on paper is the task count of the same month on the «Por mes» screen", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza cuenta ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const screen = await open(browser, baseURL!, person, PHONE, `/metas/${id}/meses`);
    const counts: number[] = [];
    try {
      const items = screen.page.getByRole("listitem");
      await expect(items).toHaveCount(5);
      for (const offset of [-1, 0, 1]) {
        const text = (await items.nth(offset + 1).textContent()) ?? "";
        counts.push(Number(/(\d+)\s+tareas?/.exec(text.replace(/\d{4}/, ""))![1]));
      }
    } finally {
      await screen.context.close();
    }
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "cuenta"), name);
      expect(section).toContain(`${labelOf(-1)} 3 de ${counts[0]} hechas`);
      expect(section).toContain(`${labelOf(0)} 2 de ${counts[1]} hechas`);
      expect(section).toContain(`${labelOf(1)} ${counts[2]} por hacer`);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 3: «diciembre de … y enero de …: sin tareas» names the months left out with their year, below the table", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza fuera ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "fuera"), name);
      const line = `${withYear(2)} y ${withYear(3)}: sin tareas`;
      expect(section).toContain(line);
      // Months out are not rows: their name is never followed by a row's cells, only by the line's «,», «y» or «:».
      for (const offset of [2, 3]) expect(section, `month ${offset} is no row`).not.toMatch(new RegExp(`${labelOf(offset)} (?:\\d|sin tareas)`));
      expect(section.indexOf(line), "below the last row").toBeGreaterThan(section.indexOf(labelOf(1)));
      expect(section.match(/sin tareas/g) ?? []).toHaveLength(1);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 3: three months out read «a, b y c: sin tareas»; a started month with no task is a row, not in the line", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza tres ${Date.now()}`;
    // -2 and -1 are closed with no task: they print; +1, +2 and +3 are out.
    const id = await seed(db, person, { name, from: -2, to: 3, tasks: { 0: { total: 2, done: 1 } } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "tres"), name);
      expect(section).toContain(`${listed([withYear(1), withYear(2), withYear(3)])}: sin tareas`);
      expect(section).toContain(`${name} · por mes · 3 meses`.toLowerCase());
      for (const offset of [-2, -1]) {
        expect(section, `closed month ${offset} is a row`).toMatch(
          new RegExp(`${labelOf(offset)} cerrado`),
        );
        expect(section, `closed month ${offset} is not in the line`).not.toMatch(new RegExp(`${withYear(offset)}(?:,| y |:)`));
      }
      expect(section).toContain(`${labelOf(0)} 1 de 2 hechas en curso`);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 3: a month to come that holds a task is a row, never in the line", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza venir ${Date.now()}`;
    // +2 holds a task though +1 holds none: +1 is out, +2 prints.
    const id = await seed(db, person, { name, from: 0, to: 3, tasks: { 0: { total: 1, done: 0 }, 2: { total: 2, done: 0 } } });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "venir"), name);
      expect(section).toContain(`${labelOf(2)} 2 por hacer por venir`);
      expect(section).toContain(`${withYear(1)} y ${withYear(3)}: sin tareas`);
      expect(section).toContain(`${name} · por mes · 2 meses`.toLowerCase());
      expect(section).not.toMatch(new RegExp(`${labelOf(1)} (?:\\d|sin tareas)`));
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 3: when no month is missing, there is no line", async ({ person, browser, baseURL, db }) => {
    const name = `Mudanza completa ${Date.now()}`;
    const id = await seed(db, person, {
      name, from: -1, to: 1, tasks: { [-1]: { total: 1, done: 1 }, 0: { total: 1, done: 0 }, 1: { total: 1, done: 0 } },
    });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "completa"), name);
      for (const offset of [-1, 0, 1]) expect(section, `row ${offset}`).toContain(labelOf(offset));
      expect(section).toContain(`${name} · por mes · 3 meses`.toLowerCase());
      expect(section).not.toContain("sin tareas");
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 3 in the print DOM: the line is visible, body text, under the table", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza dom ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      await page.emulateMedia({ media: "print" });
      const section = page.locator("section").filter({ hasText: `${name} · por mes` }).last();
      const line = section.getByText(`${withYear(2)} y ${withYear(3)}: sin tareas`, { exact: true }).locator("visible=true");
      await expect(line).toHaveCount(1);
      const grid = section.locator("table").locator("visible=true").first();
      const table = await grid.boundingBox();
      const lastMonth = await grid.locator("tbody tr:not([data-row='months-out']):not([data-unprinted])").last().boundingBox();
      const at = await line.boundingBox();
      expect(at!.y, "the line sits under the last month row").toBeGreaterThanOrEqual(lastMonth!.y + lastMonth!.height - 1);
      expect(at!.y + at!.height, "and at the end of the table").toBeLessThanOrEqual(table!.y + table!.height + 1);
      await expect(grid.locator("tbody tr[data-row='months-out']"), "in the table's last row").toHaveCount(1);
      const look = await line.evaluate((node) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--pulsar-text-line-size)";
        document.body.append(probe);
        const wanted = getComputedStyle(probe).fontSize;
        probe.remove();
        const style = getComputedStyle(node);
        return { size: style.fontSize, wanted, family: style.fontFamily };
      });
      expect(look.size, "body-line size").toBe(look.wanted);
      expect(look.family).not.toMatch(/mono/i);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  // The critic's sweep of papel-ano-cortes: k tasks in the first goal move every page cut that follows it.
  for (let k = 0; k <= 12; k++) {
    test(`clause 4: with ${k} tasks in the first goal, each unmeasured goal's label, rows and «sin tareas» line are on one page`, async ({
      person, browser, baseURL, db,
    }) => {
      const stamp = Date.now();
      const names = ["A", "B", "C", "D", "E"].map((letter) => `Meta ${letter} ${stamp}`);
      const ids: string[] = [];
      for (const [i, name] of names.entries()) {
        ids.push(await seed(db, person, {
          name, from: -1, to: 4, tasks: { [-1]: { total: 1, done: 1 }, 0: { total: i === 0 ? k : 3, done: 0 } },
        }));
      }
      const { context, page } = await open(browser, baseURL!, person, A4);
      try {
        await waitFor(page, names[0]);
        const pages = pagesOf(await printed(page, `k${k}`));
        for (const name of names) {
          const label = `${name} · por mes`.toLowerCase();
          const holder = pages.filter((text) => text.includes(label));
          expect(holder, `label of ${name} on exactly one page`).toHaveLength(1);
          const after = holder[0].slice(holder[0].indexOf(label));
          const block = after.includes("· por mes", label.length) ? after.slice(0, after.indexOf("· por mes", label.length)) : after;
          expect(block, `${name}: first row`).toContain(labelOf(-1));
          expect(block, `${name}: last row`).toContain(labelOf(0));
          expect(block, `${name}: the line on the label's page`).toContain(": sin tareas");
        }
      } finally {
        await context.close();
        await remove(db, person, ids);
      }
    });
  }

  for (const viewport of [WIDE, PHONE]) {
    test(`clause 5 on screen at ${viewport.width} px: the report shows the goal's «por mes» as paper does (RP-124), no left-out line`, async ({
      person, browser, baseURL, db,
    }) => {
      const name = `Mudanza pantalla ${Date.now()}`;
      const id = await seed(db, person, BOARD(name));
      const { context, page } = await open(browser, baseURL!, person, viewport);
      try {
        await waitFor(page, name);
        await expect(page.getByText(`no mide nada · hasta el ${lastDay(3)}`).locator("visible=true")).toHaveCount(1);
        await expect(page.getByText(/· por mes/i).locator("visible=true")).toHaveCount(1);
        await expect(page.getByText(/\d+ de \d+ hechas/).locator("visible=true").first()).toBeVisible();
        await expect(page.getByText(/: sin tareas$/).locator("visible=true")).toHaveCount(1);
      } finally {
        await context.close();
        await remove(db, person, [id]);
      }
    });
  }

  test("clause 5 on screen: the goal's «Por mes» keeps its rows: a count of tasks or nothing, never «sin tareas», nor of done or to do", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Mudanza meses ${Date.now()}`;
    const id = await seed(db, person, BOARD(name));
    const { context, page } = await open(browser, baseURL!, person, PHONE, `/metas/${id}/meses`);
    try {
      const items = page.getByRole("listitem");
      await expect(items).toHaveCount(5);
      await expect(items.nth(0)).toContainText("3 tareas");
      await expect(items.nth(1)).toContainText("en curso");
      await expect(items.nth(2)).toContainText("1 tarea");
      await expect(items.nth(3)).not.toContainText("tarea");
      await expect(items.nth(4)).not.toContainText("tarea");
      await expect(page.getByText(/hechas|por hacer|por venir/)).toHaveCount(0);
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 6: a measured goal prints as before: HECHO, «sin monto», its count of printed months", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Correr ${Date.now()}`;
    const id = await seed(db, person, {
      name, from: -1, to: 3, tasks: {}, measured: { unit: "km", budgets: [-1, 0] },
    });
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, name);
      const section = sectionOf(await printed(page, "medida"), name);
      expect(section).toContain(`${name} · por mes · 2 meses`.toLowerCase());
      expect(section).toMatch(header("hecho"));
      expect(section).not.toMatch(header("tareas"));
      expect(section).not.toMatch(/hechas|por hacer|por venir/);
      expect(section).toContain(`${listed([withYear(1), withYear(2), withYear(3)])}: sin monto`);
      expect(section).not.toContain("sin tareas");
    } finally {
      await context.close();
      await remove(db, person, [id]);
    }
  });

  test("clause 6: a measured and an unmeasured goal on one paper keep each its own table", async ({
    person, browser, baseURL, db,
  }) => {
    const stamp = Date.now();
    const bare = `Mudanza mixta ${stamp}`;
    const km = `Correr mixta ${stamp}`;
    const ids = [
      await seed(db, person, BOARD(bare)),
      await seed(db, person, { name: km, from: -1, to: 3, tasks: {}, measured: { unit: "km", budgets: [-1, 0] } }),
    ];
    const { context, page } = await open(browser, baseURL!, person, A4);
    try {
      await waitFor(page, bare);
      const file = await printed(page, "mixta");
      const bareSection = sectionOf(file, bare);
      const kmSection = sectionOf(file, km);
      expect(bareSection).not.toMatch(header("hecho"));
      expect(bareSection).toContain(": sin tareas");
      expect(bareSection).not.toContain("sin monto");
      expect(kmSection).toMatch(header("hecho"));
      expect(kmSection).not.toMatch(header("tareas"));
      expect(kmSection).toContain(": sin monto");
      expect(kmSection).not.toContain("sin tareas");
    } finally {
      await context.close();
      await remove(db, person, ids);
    }
  });
});
