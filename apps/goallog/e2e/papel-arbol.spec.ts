import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// The paper report groups by general goal (RP-84, RP-77, RP-95; user decision 2026-10-12, superseding
// `JerarquiaInforme` on paper): the general first and its goals inside, each printed whole with its note, months and
// phases and no page cap; months with no amount in one line; a general's heading never alone at the foot of a page.
// Every month is an offset from the real current month.
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const nameOf = (offset: number) => MONTHS[Number(startOf(offset).slice(5, 7)) - 1];
const labelOf = (offset: number) => `${nameOf(offset)} ${startOf(offset).slice(0, 4)}`;

const A4 = { width: 794, height: 1123 };
// Long enough to take a second line on paper, which moves the cut by a line instead of by a task.
const LONG = "revisar el cuaderno de apuntes y ordenar las notas por tema antes de pasarlas en limpio al archivo del mes";

type Tree = {
  stamp: number;
  general: string;
  big1: string;
  small: string;
  big2: string;
  note: string[];
  longNote: string[];
  aim: string;
};

// G (minutes, 12 months) > g1 (3 months, a phase, a 30-line note) > p, G > g2 (9 months of amount), G > g3.
// G's months 9 to 11 have no amount and one task each. `filler` open tasks of a loose goal, created before G, print above it.
async function seedTree(db: postgres.Sql, person: Person, filler = 0, wrapped = 0): Promise<Tree> {
  const stamp = Date.now();
  const tree: Tree = {
    stamp,
    general: `Rojo ${stamp}`,
    big1: `Alfa ${stamp}`,
    small: `Pico ${stamp}`,
    big2: `Beta ${stamp}`,
    note: [`Regla uno ${stamp}`, `Regla dos ${stamp}`, `Regla tres ${stamp}`],
    longNote: Array.from({ length: 30 }, (_, i) => `Apunte ${i + 1} de alfa ${stamp}`),
    aim: `Fase de arranque ${stamp}`,
  };
  const created = `${startOf(0)}T12:00:00Z`;
  const goal = async (name: string, horizon: number, parent: string | null, note: string | null, at = created) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, note, created_at)
      values (${person.id}, ${name}, ${startOf(horizon)}::date, 'minutos', 'minutos', ${parent}, ${note}, ${at}::timestamptz)
      returning id
    `;
    return row.id;
  };
  const budget = (goalId: string, offset: number, amount: number) => db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${startOf(offset)}::date, ${amount})
  `;
  const task = async (goalId: string, name: string, estimate: number | null, done: boolean, offset = 0) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goalId}, ${name}, ${startOf(offset)}::date, ${estimate})
      returning id
    `;
    if (done) {
      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day)
        values (${person.id}, ${goalId}, ${row.id}, ${todayInZone()}::date)
      `;
      // Hours come from blocks alone (RP-128): the done task's time is a block of its own.
      const [commitment] = await db<{ id: string }[]>`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
        values (${person.id}, ${goalId}, ${`Bloque ${name}`}, 'daily', 'quantity', 10, 'minutos') returning id
      `;
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
        values (${person.id}, ${goalId}, ${commitment.id}, ${todayInZone()}::date, ${estimate})
      `;
    }
  };

  if (filler > 0) {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Previa ${stamp}`}, ${startOf(3)}::date, ${`${startOf(0)}T11:00:00Z`}::timestamptz)
      returning id
    `;
    for (let n = 0; n < filler; n++) {
      await db`
        insert into goals.one_offs (user_id, goal_id, name, planned_month)
        values (${person.id}, ${row.id}, ${n < wrapped ? `Previa ${n} ${LONG}` : `Previa ${n}`}, ${startOf(0)}::date)
      `;
    }
  }
  const general = await goal(tree.general, 12, null, tree.note.join("\n"));
  await budget(general, 0, 999);
  const big1 = await goal(tree.big1, 3, general, tree.longNote.join("\n"));
  const small = await goal(tree.small, 2, big1, null);
  const big2 = await goal(tree.big2, 9, general, null);
  await goal(`Gama ${stamp}`, 4, general, null);
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${big1}, ${tree.aim}, ${startOf(0)}::date, ${startOf(1)}::date)
  `;
  await budget(small, 0, 1200);
  await budget(small, 1, 600);
  await task(small, `Hecha pico ${stamp}`, 510, true);
  for (let offset = 0; offset < 9; offset++) await budget(big2, offset, 1020);
  await task(big2, `Hecha beta ${stamp}`, 240, true);
  for (const offset of [9, 10, 11]) await task(general, `Cerrar ciclo ${offset} ${stamp}`, null, false, offset);
  return tree;
}

const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

async function printed(browser: Browser, baseURL: string, person: Person, name: string, label: string): Promise<string> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: A4 });
  try {
    const page: Page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `arbol-${label}-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    return file;
  } finally {
    await context.close();
  }
}

function pagesOf(file: string): string[][] {
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

const labelLine = (lines: string[], name: string) => lines.findIndex((l) => l.startsWith(`${name.toLowerCase()} · por mes`));

test.describe("the paper report groups by general goal (RP-84, RP-95, RP-77)", () => {
  test("the general prints its own «por mes» table and the goals inside print none: they stay on their own screens (RP-124)", async ({
    person, browser, baseURL, db,
  }) => {
    const t = await seedTree(db, person);
    try {
      const lines = pagesOf(await printed(browser, baseURL!, person, t.general, "orden")).flat();
      expect(labelLine(lines, t.general), "G's table").toBeGreaterThanOrEqual(0);
      for (const name of [t.big1, t.small, t.big2]) {
        expect(labelLine(lines, name), `${name} prints no table of its own`).toBe(-1);
      }
      const inside = lines.findIndex((l) => l.startsWith("metas dentro · 4"));
      expect(inside, "the general still lists the 4 goals inside it").toBeGreaterThanOrEqual(0);
    } finally {
      await clear(db, person);
    }
  });

  test("the general's note prints whole, its three lines kept as lines, in order", async ({ person, browser, baseURL, db }) => {
    const t = await seedTree(db, person);
    try {
      const lines = pagesOf(await printed(browser, baseURL!, person, t.general, "nota")).flat();
      const first = lines.indexOf(t.note[0].toLowerCase());
      expect(first, "the note's first line is a line of its own").toBeGreaterThanOrEqual(0);
      expect(lines.slice(first, first + 3)).toEqual(t.note.map((l) => l.toLowerCase()));
    } finally {
      await clear(db, person);
    }
  });

  test("a goal inside prints no section of its own: its 30-line note and its phase stay on its screen (RP-124)", async ({
    person, browser, baseURL, db,
  }) => {
    const t = await seedTree(db, person);
    try {
      const lines = pagesOf(await printed(browser, baseURL!, person, t.general, "entera")).flat();
      expect(lines.indexOf(t.longNote[0].toLowerCase()), "g1's note does not print").toBe(-1);
      expect(lines.findIndex((l) => l.includes(t.aim.toLowerCase())), "g1's phase does not print").toBe(-1);
      expect(lines.indexOf(t.note[0].toLowerCase()), "the general's own note still prints").toBeGreaterThanOrEqual(0);
    } finally {
      await clear(db, person);
    }
  });

  test("months with no amount are one line, not rows, and the table's count is the rows printed", async ({
    person, browser, baseURL, db,
  }) => {
    const t = await seedTree(db, person);
    try {
      const lines = pagesOf(await printed(browser, baseURL!, person, t.general, "sinmonto")).flat();
      const general = labelLine(lines, t.general);
      expect(general, "G's table").toBeGreaterThanOrEqual(0);
      const region = lines.slice(general);

      expect(region[0], "the count is the 9 printed rows, not the 12 months").toBe(
        `${t.general.toLowerCase()} · por mes · 9 meses`,
      );
      for (const offset of range(9)) {
        expect(region.filter((l) => l.startsWith(labelOf(offset))), `row ${labelOf(offset)} once`).toHaveLength(1);
      }
      for (const offset of [9, 10, 11]) {
        expect(region.filter((l) => l.startsWith(labelOf(offset)) && !l.startsWith(`${labelOf(offset)},`)), `${labelOf(offset)} is no row`).toHaveLength(0);
      }

      const line = new RegExp(`${labelOf(9)}, ${labelOf(10)} y ${labelOf(11)}: sin monto · 1 tarea$`);
      expect(region.filter((l) => line.test(l)), "one line names the three months").toHaveLength(1);
      expect(region.filter((l) => l.includes("sin monto")), "and says «sin monto» once").toHaveLength(1);
    } finally {
      await clear(db, person);
    }
  });

  // Chromium ignores `break-*: avoid` between siblings: prove the rule by moving the cut under the general's heading,
  // a task at a time across the whole report and a line at a time around the two cuts the heading crosses.
  const fine = [6, 7, 8, 9, 22, 23, 24, 25];
  const cuts: [number, number][] = [
    ...range(10).map((i) => i * 4).filter((n) => !fine.includes(n)).map((n): [number, number] => [n, 0]),
    ...fine.flatMap((n) => range(4).map((w): [number, number] => [n, w])),
  ];
  for (const [above, wrapped] of cuts) {
    test(`${above} open tasks of a goal before it, ${wrapped} on two lines: the general's heading is not alone at the foot of a page`, async ({
      person, browser, baseURL, db,
    }) => {
      const t = await seedTree(db, person, above, wrapped);
      try {
        const pages = pagesOf(await printed(browser, baseURL!, person, t.general, `corte${above}-${wrapped}`));
        const name = t.general.toLowerCase();
        const page = pages.findIndex((l) => l.includes(name));
        expect(page, "G's heading is printed").toBeGreaterThanOrEqual(0);
        const lines = pages[page];
        const at = lines.findIndex((l) => l.includes(name));
        expect(at, `heading on page ${page + 1} of ${pages.length}`).toBeLessThan(lines.length - 1);
        expect(
          lines.some((l) => l.includes("12 h 30 min")),
          `G's first figures share page ${page + 1} with its heading`,
        ).toBe(true);
      } finally {
        await clear(db, person);
      }
    });
  }
});

function range(count: number) {
  return Array.from({ length: count }, (_, i) => i);
}
