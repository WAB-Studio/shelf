import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `PapelSigueLaPantalla` (RP-84, RP-124; approved 2026-10-14): what the person sees on `/exportar` at 1280 is what the
// PDF prints. A goal inside a general prints no section of its own; its tasks sit in the general's list, named «· Meta».
// A goal that holds goals never says «estos meses con monto propio:». The summary says «2.100 de 6.000 palabras» once.
// A month in a list is named as its row names it, «marzo 2027», never «marzo de 2027».
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const labelOf = (offset: number) => `${MONTHS[Number(startOf(offset).slice(5, 7)) - 1]} ${startOf(offset).slice(0, 4)}`;
const thisMonthName = MONTHS[Number(startOf(0).slice(5, 7)) - 1];

const A4 = { width: 794, height: 1123 };
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const count = (text: string, part: string) => text.split(part).length - 1;

const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

// K1: «Carrera en IA» > «IA aplicada» > «Evals y harness»; two tasks on the general, two on the goal at the bottom,
// which plans 12 h in each of five months.
async function seedK1(db: postgres.Sql, person: Person) {
  const created = `${startOf(0)}T12:00:00Z`;
  const goal = async (name: string, parent: string | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
      values (${person.id}, ${name}, ${startOf(14)}::date, 'minutos', 'minutos', ${parent}, ${created}::timestamptz)
      returning id`;
    return row.id;
  };
  const general = await goal("Carrera en IA", null);
  const middle = await goal("IA aplicada", general);
  const bottom = await goal("Evals y harness", middle);
  for (const offset of [0, 1, 2, 3, 4]) {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${bottom}, ${startOf(offset)}::date, 720)`;
  }
  const task = (goalId: string, name: string, estimate: number) => db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${name}, ${startOf(0)}::date, ${estimate})`;
  await task(general, "Definir el rumbo del año", 120);
  await task(general, "Armar el portafolio", 180);
  await task(bottom, "Leer sobre evals", 150);
  await task(bottom, "Montar el harness", 90);
}

async function screenText(browser: Browser, baseURL: string, person: Person, first: string): Promise<string> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText(first, { exact: true }).first()).toBeVisible();
    return flat(await page.getByRole("main").innerText());
  } finally {
    await context.close();
  }
}

async function paperText(browser: Browser, baseURL: string, person: Person, first: string, label: string): Promise<string> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: A4 });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText(first, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `sigue-${label}-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    return flat(execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }));
  } finally {
    await context.close();
  }
}

// The labels a goal's block opens its sections with.
const LABELS = ["este mes ·", "hasta hoy", `tareas de ${thisMonthName}`, "· por mes"];

test.describe("the paper follows the screen (RP-84, RP-124)", () => {
  test("K1: the PDF prints no section for «IA aplicada» or «Evals y harness», and names their tasks in the general's list", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: leaving the `PrintOnly` of each goal inside.
    await seedK1(db, person);
    try {
      const paper = await paperText(browser, baseURL!, person, "Carrera en IA", "k1-seccion");
      expect(paper, "no «por mes» table for a goal inside").not.toContain("ia aplicada · por mes");
      expect(paper).not.toContain("evals y harness · por mes");
      expect(count(paper, "este mes ·"), "one «este mes» block: the general's").toBe(1);
      expect(count(paper, `tareas de ${thisMonthName}`), "one list of tasks: the general's").toBe(1);
      for (const task of ["definir el rumbo del año", "armar el portafolio", "leer sobre evals", "montar el harness"]) {
        expect(count(paper, task), `${task} once`).toBe(1);
      }
      expect(count(paper, "evals y harness"), "its name: in «metas dentro», in the summary and on the two tasks").toBeGreaterThanOrEqual(2);
      expect(paper).toMatch(/leer sobre evals[^]{0,40}· evals y harness/);
      expect(paper).toMatch(/montar el harness[^]{0,40}· evals y harness/);
    } finally {
      await clear(db, person);
    }
  });

  test("K1: the screen and the PDF open the same sections, as many times each", async ({ person, browser, baseURL, db }) => {
    // Kills: printing the phases, the months or the figures of a goal inside; a section only the screen draws.
    await seedK1(db, person);
    try {
      const screen = await screenText(browser, baseURL!, person, "Carrera en IA");
      const paper = await paperText(browser, baseURL!, person, "Carrera en IA", "k1-igual");
      for (const label of LABELS) {
        expect(count(paper, label), `«${label}» on paper as on screen`).toBe(count(screen, label));
      }
      expect(count(screen, "este mes ·")).toBe(1);
    } finally {
      await clear(db, person);
    }
  });

  test("K1: a goal that holds goals says «estos meses con monto propio:» neither on screen nor on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: ignoring `holdsGoals` when the months are split into own and the rest.
    await seedK1(db, person);
    try {
      const screen = await screenText(browser, baseURL!, person, "Carrera en IA");
      const paper = await paperText(browser, baseURL!, person, "Carrera en IA", "k1-propio");
      expect(screen).not.toContain("monto propio");
      expect(paper).not.toContain("monto propio");
    } finally {
      await clear(db, person);
    }
  });

  test("K5: the summary says «2.100 de 6.000 palabras», the unit once, on screen and on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: `summary.of` as «{done} de {planned}» with each figure carrying its own unit.
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, 'Escribir', ${startOf(5)}::date, 'palabras', 'palabras', ${`${startOf(0)}T12:00:00Z`}::timestamptz)
      returning id`;
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${startOf(0)}::date, 6000)`;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Escribir cada día', 'daily', 'quantity', 500, 'palabras', now() - interval '20 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${todayInZone()}::date, 2100)`;
    try {
      const screen = await screenText(browser, baseURL!, person, "Escribir");
      const paper = await paperText(browser, baseURL!, person, "Escribir", "k5");
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        expect(count(text, "2.100 de 6.000 palabras"), `${where}: the summary line`).toBeGreaterThanOrEqual(1);
        // The detail below the summary sets two figure columns side by side, which the PDF reads across.
        const summary = text.slice(0, text.indexOf("el detalle de cada meta"));
        expect(summary, `${where}: no unit after the figure`).not.toMatch(/2\.100 palabras de/);
        expect(summary, `${where}: no unit after the figure`).not.toMatch(/palabras de 6\.000/);
      }
    } finally {
      await clear(db, person);
    }
  });

  test("months in a list are named as their rows, never «mes de año»", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: `monthYear.format` printing «mes de año» in the lists of months out.
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, 'Ocho meses', ${startOf(9)}::date, 'minutos', 'minutos', ${`${startOf(0)}T12:00:00Z`}::timestamptz)
      returning id`;
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${startOf(0)}::date, 600)`;
    try {
      const out = [1, 2, 3, 4, 5, 6, 7, 8].map(labelOf);
      const line = `${out.slice(0, -1).join(", ")} y ${out[out.length - 1]}: sin monto`;
      const screen = await screenText(browser, baseURL!, person, "Ocho meses");
      const paper = await paperText(browser, baseURL!, person, "Ocho meses", "meses-filas");
      expect(paper, "the line on paper").toContain(line);
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        for (const offset of [1, 2, 3, 4, 5, 6, 7]) {
          const [name, year] = labelOf(offset).split(" ");
          expect(text, `${where}: «${name} de ${year}»`).not.toContain(`${name} de ${year}`);
        }
      }
    } finally {
      await clear(db, person);
    }
  });
});
