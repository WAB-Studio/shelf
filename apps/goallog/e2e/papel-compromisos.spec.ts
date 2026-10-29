import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `PapelSigueLaPantalla` caras 2 y 3 (RP-124; Q2 = a, 2026-10-14): after a goal's measure, «COMPROMISOS» and one line per
// live commitment, in its order (days in full, «martes y jueves», RP-133; Hoy keeps «mar y jue»), «{nombre} · {cadencia}» and «· {cantidad}» for one that counts; a goal with none has no
// label. A «POR MES» whose every row holds no task and no amount is not drawn, on screen and on paper; one that holds a
// task is drawn on both, its row saying «1 tarea». Every assertion is made on the screen at 1280 and on the PDF.
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

const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const count = (text: string, part: string) => text.split(part).length - 1;
const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

async function bothTexts(browser: Browser, baseURL: string, person: Person, first: string, label: string) {
  const screenCtx = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width: 1280, height: 900 } });
  const paperCtx = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width: 794, height: 1123 } });
  try {
    const screenPage = await screenCtx.newPage();
    await screenPage.goto("/exportar");
    await expect(screenPage.getByRole("main").getByText(first, { exact: true }).first()).toBeVisible();
    const screen = flat(await screenPage.getByRole("main").innerText());

    const page = await paperCtx.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText(first, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `compromisos-${label}-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const paper = flat(execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }));
    return { screen, paper };
  } finally {
    await screenCtx.close();
    await paperCtx.close();
  }
}

type Commitment = { name: string; kind?: "daily" | "times_per_week"; n?: number; quantity?: number; unit?: string; retired?: boolean };

// Created one after the other, so the order of creation is the order they were given.
async function seedGoal(db: postgres.Sql, person: Person, name: string, horizon: number | null, commitments: Commitment[]) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${name}, ${horizon === null ? null : startOf(horizon)}::date, ${`${startOf(0)}T12:00:00Z`}::timestamptz)
    returning id`;
  let age = commitments.length + 20;
  for (const c of commitments) {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit, created_at, retired_at)
      values (${person.id}, ${goal.id}, ${c.name}, ${c.kind ?? "daily"}, ${c.n ?? null}, ${c.quantity ? "quantity" : "tap"},
              ${c.quantity ?? null}, ${c.quantity ? (c.unit ?? null) : null}, now() - make_interval(days => ${age--}),
              ${c.retired ? new Date() : null})`;
  }
  return goal.id;
}

test.describe("commitments and «por mes» on the export screen and on paper (RP-124)", () => {
  test("K3: «compromisos» and its two lines in order, once each, and no «por mes», on screen and on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: no section; a section that also lists the retired one; a «por mes» the goal has nothing to put in.
    await seedGoal(db, person, "Cuidado personal", null, [
      { name: "Estirar" },
      { name: "Tomar agua" },
      { name: "Antiguo", retired: true },
    ]);
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Cuidado personal", "k3");
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        expect(text, `${where}: the label`).toContain("compromisos");
        const first = text.indexOf("estirar · todos los días");
        const second = text.indexOf("tomar agua · todos los días");
        expect(first, `${where}: «Estirar · todos los días»`).toBeGreaterThanOrEqual(0);
        expect(second, `${where}: «Tomar agua · todos los días»`).toBeGreaterThan(first);
        expect(count(text, "estirar · todos los días"), `${where}: once`).toBe(1);
        expect(count(text, "tomar agua · todos los días"), `${where}: once`).toBe(1);
        expect(text, `${where}: the retired one`).not.toContain("antiguo");
        expect(text, `${where}: the label follows «no mide nada»`).toMatch(/no mide nada[^]*compromisos[^]*estirar/);
        expect(text, `${where}: no «por mes»`).not.toContain("por mes");
        expect(text, `${where}: no empty rows`).not.toContain("sin tareas");
      }
    } finally {
      await clear(db, person);
    }
  });

  test("a goal with an end and no measure, every month empty: no «por mes» and no «sin tareas», on screen and on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: a table of empty months drawn because the goal has an end; a line naming the empty months.
    await seedGoal(db, person, "Mudanza vacía", 3, [{ name: "Empacar a diario" }]);
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Mudanza vacía", "k3b");
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        expect(text, `${where}: the commitment`).toContain("empacar a diario · todos los días");
        expect(text, `${where}: no «por mes»`).not.toContain("por mes");
        expect(text, `${where}: no «sin tareas»`).not.toContain("sin tareas");
        expect(text, `${where}: no month named`).not.toContain(labelOf(2));
      }
    } finally {
      await clear(db, person);
    }
  });

  test("a commitment that counts prints its amount: «Rodaje · 3 veces por semana · 5 km»", async ({ person, browser, baseURL, db }) => {
    // Kills: dropping the quantity from the line; the cadence phrase of another kind.
    await seedGoal(db, person, "Correr", null, [{ name: "Rodaje", kind: "times_per_week", n: 3, quantity: 5, unit: "km" }]);
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Correr", "cantidad");
      expect(screen).toContain("rodaje · 3 veces por semana · 5 km");
      expect(paper).toContain("rodaje · 3 veces por semana · 5 km");
    } finally {
      await clear(db, person);
    }
  });

  test("a goal with no commitments prints no «compromisos» label, and nor does one with only a retired commitment", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: an empty label.
    await seedGoal(db, person, "Sin hábitos", null, []);
    await seedGoal(db, person, "Solo retirado", null, [{ name: "Dejado", retired: true }]);
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Sin hábitos", "sin");
      expect(screen).not.toContain("compromisos");
      expect(paper).not.toContain("compromisos");
    } finally {
      await clear(db, person);
    }
  });

  test("K4: a goal that measures nothing and holds a task draws «por mes» with its row «1 tarea», on screen and on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: silencing every goal with no measure; the count of tasks missing from the row.
    const id = await seedGoal(db, person, "Cocina", 5, []);
    await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, 'Probar una receta nueva', ${startOf(0)}::date)`;
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Cocina", "k4");
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        expect(text, `${where}: «por mes»`).toContain("cocina · por mes");
        const at = text.indexOf(labelOf(0));
        expect(at, `${where}: the current month's row`).toBeGreaterThanOrEqual(0);
        expect(text.slice(at, at + 40), `${where}: its count`).toContain("0 de 1 hechas");
      }
    } finally {
      await clear(db, person);
    }
  });

  test("K1: a goal inside a general prints its commitments under its «dentro» row, one line each, the unit said once, on screen and on paper", async ({
    person, browser, baseURL, db,
  }) => {
    // Kills: «dentro» rows with no commitments; the line of a standalone goal drawn in another form; the unit twice in the row.
    const [root] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, 'Carrera en IA', ${startOf(12)}::date, ${`${startOf(0)}T12:00:00Z`}::timestamptz) returning id`;
    const [mid] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, parent_id, created_at)
      values (${person.id}, 'IA aplicada', ${startOf(6)}::date, ${root.id}, ${`${startOf(0)}T12:00:00Z`}::timestamptz) returning id`;
    const [leaf] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, parent_id, measure_name, measure_unit, created_at)
      values (${person.id}, 'Evals y harness', ${startOf(4)}::date, ${mid.id}, 'palabras', 'palabras', ${`${startOf(0)}T12:00:00Z`}::timestamptz) returning id`;
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${leaf.id}, ${startOf(0)}::date, 6000)`;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${leaf.id}, 'Tema técnico', 'weekdays', ${[2, 4]}, 'quantity', 120, 'minutos', now() - interval '3 days')`;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${leaf.id}, 'Inglés pasivo', 'daily', 'tap', now() - interval '2 days')`;
    try {
      const { screen, paper } = await bothTexts(browser, baseURL!, person, "Carrera en IA", "k1");
      for (const [where, text] of [["screen", screen], ["paper", paper]] as const) {
        const at = text.indexOf("metas dentro · 2");
        expect(at, `${where}: the «dentro» section`).toBeGreaterThanOrEqual(0);
        const first = text.indexOf("tema técnico · martes y jueves · 2 h");
        const second = text.indexOf("inglés pasivo · todos los días");
        expect(first, `${where}: «Tema técnico · martes y jueves · 2 h»`).toBeGreaterThan(at);
        expect(second, `${where}: «Inglés pasivo · todos los días»`).toBeGreaterThan(first);
        expect(count(text, "tema técnico · martes y jueves · 2 h"), `${where}: once`).toBe(1);
        expect(text, `${where}: no short days`).not.toContain("mar y jue");
        const row = text.slice(text.indexOf("metas dentro"), first);
        expect(row, `${where}: the unit once`).toMatch(/octubre · 0 de 6\.000 palabras/);
        expect(row, `${where}: the unit not twice`).not.toMatch(/palabras de [\d.]+ palabras/);
      }
    } finally {
      await clear(db, person);
    }
  });
});
