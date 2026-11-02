import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";
import { boxOf } from "./box";

// Module 813 (RP-71, RP-32, RP-17, RP-35), `MesesFuturoYTareas` 6a and `MesesConAño` option B: no `Table` prints a
// unit the catalogue translates («searches»), a unit other than time is said once, and the phone's label column is
// 128px in every table so a month with its year never breaks in two lines.

const thisMonth = monthOf(todayInZone());
const today = todayInZone();
// Opened on last week's Monday, so today always falls in «semana 2», whatever weekday today is.
const openedAt = civilDateToDate(weekOf(today)[0]);
openedAt.setUTCDate(openedAt.getUTCDate() - 7);

type Db = postgres.Sql;
type Unit = { measure: string; unit: string };
const SEARCHES: Unit = { measure: "búsquedas", unit: "searches" };
const KM: Unit = { measure: "km", unit: "km" };
const MINUTES: Unit = { measure: "minutos", unit: "minutos" };

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const monthName = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function seedGoal(
  db: Db,
  person: Person,
  options: { name: string; unit: Unit; months?: number; amount?: number | null; fact?: number },
): Promise<string> {
  const months = options.months ?? 2;
  let horizon = thisMonth;
  const starts: string[] = [];
  for (let i = 0; i < months; i += 1) {
    starts.push(horizon);
    horizon = nextMonth(horizon);
  }
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`${options.name} ${Date.now()}`}, ${horizon}::date, ${options.unit.measure}, ${options.unit.unit},
            ${openedAt})
    returning id`;
  if (options.amount !== null && options.amount !== undefined) {
    for (const month of starts) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${month}::date, ${options.amount})`;
    }
  }
  if (options.fact !== undefined) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, ${options.unit.unit}, ${openedAt})
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${today}::date, ${options.fact})`;
  }
  return goal.id;
}

async function visit(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  path: string,
  width: number,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  return { page, close: () => context.close() };
}

// A visible row of the phone's stack whose text starts with `start`.
const row = (page: Page, start: RegExp | string) =>
  page.locator("ol > li:visible").filter({ hasText: start }).first();

async function drop(db: Db, person: Person, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
}

test("revision at 360, a searches goal: «semana 1» ends in «0 búsquedas» and no table says «searches»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Revisión búsquedas", unit: SEARCHES });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    await expect(row(page, "semana 1")).toBeVisible();
    expect(flat(await row(page, "semana 1").innerText())).toMatch(/0 búsquedas$/);
    expect(await page.getByRole("main").first().innerText()).not.toMatch(/searches/i);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("exportar at 360, the month in progress: «0 búsquedas», the unit once, never «searches»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Exportar búsquedas", unit: SEARCHES, amount: 60 });
  const { page, close } = await visit(browser, baseURL, person, "/exportar", 360);
  try {
    const current = row(page, /en curso/);
    await expect(current).toBeVisible();
    const text = flat(await current.innerText());
    expect(text).toContain("0 búsquedas");
    expect(text).not.toMatch(/searches/i);
    expect(text.match(/búsquedas/g)).toHaveLength(1); // «de 60 búsquedas»: the unit once, at the end
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a week with 1 reads «1 búsqueda» in the singular", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Singular", unit: SEARCHES, fact: 1 });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    const week = row(page, "semana 2");
    await expect(week).toBeVisible();
    expect(flat(await week.innerText())).toMatch(/1 búsqueda(?!s)/);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

// The review's weeks are bars, each total a Figure beside its name (DESIGN «Decisión del 2026-10-31»): the unit stands in every total.
test("revision at 1440: the weeks' totals say «búsquedas», not «searches»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Cabecera búsquedas", unit: SEARCHES });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 1440);
  try {
    const weeks = page.getByRole("list", { name: "por semana" });
    await expect(weeks).toBeVisible();
    await expect(weeks.locator("li").first()).toContainText("búsquedas");
    await expect(weeks).not.toContainText("searches");
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("exportar at 1440: the «hecho» header of a searches goal says «búsquedas»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Hecho búsquedas", unit: SEARCHES, amount: 60 });
  const { page, close } = await visit(browser, baseURL, person, "/exportar", 1440);
  try {
    const header = page.locator("thead th:visible").filter({ hasText: "hecho" });
    await expect(header).toHaveCount(1);
    await expect(header).toContainText("búsquedas");
    await expect(header).not.toContainText("searches");
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a free unit (km) stays as typed: «6 km» beside the figure and «km» in every total", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Meta km", unit: KM, fact: 6 });
  const path = `/metas/${goalId}/revision`;
  const phone = await visit(browser, baseURL, person, path, 360);
  try {
    const week = row(phone.page, "semana 2");
    await expect(week).toBeVisible();
    expect(flat(await week.innerText())).toMatch(/\b6 km\b/);
  } finally {
    await phone.close();
  }
  const wide = await visit(browser, baseURL, person, path, 1440);
  try {
    const weeks = wide.page.getByRole("list", { name: "por semana" });
    await expect(weeks.locator("li").first()).toContainText("km");
    await expect(weeks).not.toContainText("kilómetro");
  } finally {
    await wide.close();
    await drop(db, person, goalId);
  }
});

test("a goal in minutes reads «4 h 30 min» with no unit word after it", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Meta tiempo", unit: MINUTES, fact: 270 });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    const week = row(page, "semana 2");
    await expect(week).toBeVisible();
    const text = flat(await week.innerText());
    expect(text).toMatch(/4 h 30 min/);
    expect(text).not.toMatch(/minutos/);
    expect(text).not.toMatch(/4 h 30 min \S*[a-zA-Záéíóú]{4,}/);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a month not reached draws «—» alone: no unit word beside the dash", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Guion", unit: SEARCHES, amount: 60 });
  const { page, close } = await visit(browser, baseURL, person, "/exportar", 360);
  try {
    const future = row(page, new RegExp(`^${monthName(nextMonth(thisMonth))} `));
    await expect(future).toBeVisible();
    const figure = future.locator(":scope > span").nth(1);
    expect(flat(await figure.innerText())).toBe("—");
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

for (const width of [360, 1024]) {
  test(`exportar at ${width}: each of 16 month labels is one line, 128px wide, and the page does not overflow`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const goalId = await seedGoal(db, person, { name: "Inglés B2+ laboral", unit: MINUTES, months: 16, amount: 720 });
    // A goal with an end of more than 12 months folds (RP-115): «ver todo» draws all 16.
    const { page, close } = await visit(browser, baseURL, person, "/exportar?todo=1", width);
    try {
      const labels = page.locator("ol > li:visible > span:first-child");
      await expect(labels.first()).toBeVisible();
      const boxes = await labels.evaluateAll((nodes) =>
        nodes
          .map((node) => {
            const style = getComputedStyle(node);
            const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
            return {
              text: (node.firstChild?.textContent ?? "").trim(),
              width: node.getBoundingClientRect().width,
              // The month's own words: the current row's «en curso» under it is not part of the line.
              height: (() => {
                const range = document.createRange();
                range.selectNodeContents(node.firstChild!);
                return range.getBoundingClientRect().height;
              })(),
              line,
            };
          })
          .filter((box) => /^[a-záéíóú]+ 20\d\d$/.test(box.text)),
      );
      // Last week's Monday falls in the month before on its first days: the goal then lives that month too.
      expect(boxes.length, "month labels drawn").toBe(monthOf(dateToCivilDate(openedAt)) < thisMonth ? 17 : 16);
      for (const box of boxes) expect(box.height, `«${box.text}» height`).toBeLessThanOrEqual(box.line * 1.5);
      for (const box of boxes) expect(box.width, `«${box.text}» width`).toBeCloseTo(128, 0);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scroll).toBeLessThanOrEqual(width);
    } finally {
      await close();
      await drop(db, person, goalId);
    }
  });
}

test("revision at 360: «semana 1» with its dates under it is a label of at least 110px, its dates on one line, and the page does not overflow", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Revisión etiqueta", unit: SEARCHES });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    const week = row(page, "semana 1");
    await expect(week).toBeVisible();
    // The bars row gives its label a column of 110px at least (`WeekBars`); the dates under the name never break in two.
    const label = week.locator('[class*="label"]').first();
    expect((await boxOf(label)).width).toBeGreaterThanOrEqual(109.5);
    expect((await boxOf(week.locator('[class*="detail"]').first())).height).toBeLessThan(24);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(360);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("the review's sentence names the measure in the catalogue's plural: «mide en búsquedas»", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, { name: "Frase plural", unit: SEARCHES });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    const main = page.getByRole("main").first();
    await expect(main).toContainText("mide en");
    expect(flat(await main.innerText())).toMatch(/mide en búsquedas(?!\p{L})/u);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

test("a unit typed capitalised («Searches») still reads the catalogue's word in the review's sentence", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const goalId = await seedGoal(db, person, { name: "Frase mayúscula", unit: { measure: "búsquedas", unit: "Searches" } });
  const { page, close } = await visit(browser, baseURL, person, `/metas/${goalId}/revision`, 360);
  try {
    const main = page.getByRole("main").first();
    await expect(main).toContainText("mide en");
    const text = flat(await main.innerText());
    expect(text).toMatch(/mide en búsquedas(?!\p{L})/u);
    expect(text).not.toMatch(/searches/i);
  } finally {
    await close();
    await drop(db, person, goalId);
  }
});

// A closed month that carried a task over says «cerrado · N % pasó a <mes>» under its label: a line that does not
// break, whose width must never widen the 128px label.
test("exportar at 360: a closed month with «cerrado · N % pasó a …» under it keeps its label 128px and the figures where they were", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const lastMonth = monthOf(dayBefore(thisMonth));
  const horizon = nextMonth(nextMonth(nextMonth(thisMonth)));
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Cerrado arrastre ${Date.now()}`}, ${horizon}::date, 'Práctica', 'minutos',
            (${lastMonth}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id`;
  for (const month of [lastMonth, thisMonth]) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${month}::date, 600)`;
  }
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month)
    values (${person.id}, ${goal.id}, ${`Pendiente ${Date.now()}`}, 110, ${lastMonth}::date)`;
  const { page, close } = await visit(browser, baseURL, person, "/exportar", 360);
  try {
    const closed = row(page, /cerrado/);
    await expect(closed).toBeVisible();
    expect(flat(await closed.innerText())).toMatch(/pasó a/);
    const label = closed.locator(":scope > span").first();
    expect((await boxOf(label)).width).toBeCloseTo(128, 0);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(360);
  } finally {
    await close();
    await drop(db, person, goal.id);
  }
});
