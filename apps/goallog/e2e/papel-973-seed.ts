import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "./fixtures";
import { PAGES, openedOnDay, seedHabit, seedOpenGoal } from "./metas-sin-final-seed";
import { monthStartOf, shift, TODAY } from "./sin-final-seed";
import { budget, openedIn, range } from "./mes-siguiente-seed";
import { horizonIn } from "./por-mes-de-n-seed";

import type { Browser, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Helper of the paper specs of module 973 (RP-120). Not a spec.

export const A4 = { width: 794, height: 1123 };

// Each sheet of `path` printed on A4, as lowercase lines of its text, whitespace squeezed.
export async function printedPages(browser: Browser, baseURL: string | undefined, person: Person, path: string, tag: string, ready: string[]): Promise<string[][]> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page: Page = await context.newPage();
    await page.goto(path);
    for (const name of ready) await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `973-${tag}-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const count = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8" }))![1]);
    return Array.from({ length: count }, (_, i) =>
      execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
        .toLowerCase()
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    );
  } finally {
    await context.close();
  }
}

// «Leer»: an end 9 months on (33 months with December at 60); `tasks` open tasks of its own this month, which slide the page cut.
export async function seedLeer33(db: Db, person: Person, tasks = 0, name = "Leer") {
  const id = await seedOpenGoal(db, person, { name, unit: PAGES, horizon: horizonIn(9), rhythm: 40, created: openedIn(-23) });
  await budget(db, person, id, 2, 60);
  await addTasks(db, person, id, tasks);
  return id;
}

export async function addTasks(db: Db, person: Person, goalId: string, count: number, prefix = "Tarea abierta") {
  for (const n of range(0, count - 1)) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${goalId}, ${`${prefix} ${n}`}, ${monthStartOf(0)}::date)`;
  }
}

// The s7 critic's shelf of goals: «Leer» as above, then four goals after it, one with no amount and one with no unit.
export async function seedShelf(db: Db, person: Person, leerTasks: number, escribirTasks = 0) {
  const leer = await seedLeer33(db, person, leerTasks);
  const escribir = await seedOpenGoal(db, person, { name: "Escribir", unit: PAGES, horizon: null, rhythm: 30, created: openedOnDay(1).at });
  await addTasks(db, person, escribir, escribirTasks, "Pendiente");
  await seedOpenGoal(db, person, { name: "Ahorrar tiempo", unit: PAGES, horizon: null, rhythm: null, created: openedIn(-7) });
  await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, horizon: null, rhythm: null, created: openedIn(-4) });
  const correr = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: null, horizon: horizonIn(2), rhythm: null, created: openedOnDay(1).at });
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${correr}, 'Preparación', ${shift(TODAY, -9)}::date, ${shift(TODAY, 39)}::date)`;
  await seedHabit(db, person, { name: "Tomar agua", cadence: "daily" });
  return leer;
}
