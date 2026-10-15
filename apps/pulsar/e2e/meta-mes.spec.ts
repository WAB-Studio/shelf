import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { boxOf } from "./box";

// `MetaMes.dc.html`, `MetaMesSinPlan.dc.html`, `MetaMesBajo.dc.html`
//: the goal says this month's amount in hours and minutes, the
// pace line from the 20th, and the way to its months. The pace branch follows
// the clock the app reads, so both are written and the one true today is
// asserted. `MetaMesSinEvidencia.dc.html` needs a source that cannot be read:
// that is `fuente-caida.spec.ts`'s server, which this spec does not drive.

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const today = todayInZone();
const day = Number(today.slice(8, 10));
const late = day >= 20;
const monthStart = `${today.slice(0, 7)}-01`;
const monthName = MONTHS[Number(today.slice(5, 7)) - 1];
const daysLeft = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate() - day;

async function seedGoal(
  db: postgres.Sql,
  person: Person,
  input: { name: string; budget: number | null; unit?: string | null; horizon?: string; archived?: boolean },
): Promise<string> {
  const unit = input.unit === undefined ? "minutos" : input.unit;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at, archived_at)
    values (${person.id}, ${input.name}, ${input.horizon ?? plusDays(90)}, ${unit}, ${unit},
            now() - interval '40 days', ${input.archived ? new Date() : null})
    returning id
  `;
  if (input.budget !== null) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${monthStart}::date, ${input.budget})
    `;
  }
  return goal.id;
}

async function quantity(db: postgres.Sql, person: Person, goalId: string, minutes: number, factDay: string) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, ${`Sesión ${minutes} ${Date.now()}`}, 'daily', 'quantity', 30, 'minutos',
            now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goalId}, ${commitment.id}, ${factDay}::date, ${minutes})
  `;
}

const seen = (page: Page, text: string) => page.getByText(text, { exact: true }).locator("visible=true");
const visible = (page: Page, text: RegExp) => page.getByText(text).locator("visible=true");

test("at 360 and 390 the goal has one h1, «Volver a Metas» lands on /metas, and the two «Ver por» links share a line (RP-23, RNP-17)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const name = `Meta encabezado ${Date.now()}`;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const goalId = await seedGoal(db, person, { name, budget: 720 });
    await quantity(db, person, goalId, 90, today);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${goalId}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      const month = (await boxOf(page.getByRole("link", { name: "Ver por mes", exact: true })));
      const week = (await boxOf(page.getByRole("link", { name: "Ver por semana", exact: true })));
      expect(Math.abs(month.y - week.y)).toBeLessThan(2);
      expect(week.x).toBeGreaterThan(month.x);
      // One row gap apart, the links' own boxes touching no one else's.
      expect(Math.round(week.x - (month.x + month.width))).toBe(16);
    }
    await page.getByRole("link", { name: "Volver a Metas" }).click();
    await expect(page).toHaveURL(/\/metas$/);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("the goal says the month's amount, moves with a done task, and links to its months (RP-28, RP-29, RP-36)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    // 720 planned: 300 + 90 declared, 390 reached; a done 15-minute task makes 405.
    const goalId = await seedGoal(db, person, { name: `Meta mes ${stamp}`, budget: 720 });
    await quantity(db, person, goalId, 300, monthStart);
    await quantity(db, person, goalId, 90, today);
    const [task] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goalId}, ${`Tarea ${stamp}`}, ${monthStart}::date, 15) returning id
    `;

    const line = (percent: number, reached: string) =>
      late
        ? `día ${day} · ${reached} de 12 h, bajo el 60 %`
        : `llevas ${percent} % · faltan ${daysLeft === 1 ? "1 día" : `${daysLeft} días`}`;

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await db`delete from goals.facts where one_off_id = ${task.id}`;
      await page.goto(`/metas/${goalId}`);
      await expect(seen(page, monthName)).toHaveCount(1);
      // The total and the month's reached figure both say 6 h 30 min.
      // The month line is one sentence; from the 20th the pace line replaces it.
      await expect(seen(page, "6 h 30 min")).toHaveCount(2);
      await expect(seen(page, "6 h 30 min de 12 h")).toHaveCount(late ? 0 : 1);
      await expect(seen(page, line(54, "6 h 30 min"))).toHaveCount(1);

      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day)
        values (${person.id}, ${goalId}, ${task.id}, ${monthStart}::date)
      `;
      await page.goto(`/metas/${goalId}`);
      await expect(seen(page, "6 h 45 min")).toHaveCount(2);
      await expect(seen(page, "6 h 30 min")).toHaveCount(0);
      await expect(seen(page, line(56, "6 h 45 min"))).toHaveCount(1);
      // Pace speaks from the 20th alone, in ink words, never before.
      await expect(visible(page, /bajo el 60 %/)).toHaveCount(late ? 1 : 0);
      await expect(visible(page, /llevas \d+ %/)).toHaveCount(late ? 0 : 1);
      if (late) await expect(visible(page, /\d+ %/).filter({ hasNotText: /60 %/ })).toHaveCount(0);
      await expect(visible(page, /sin monto planeado/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: `Planear ${monthName}` })).toHaveCount(0);

      const months = page.getByRole("link", { name: "Ver por mes", exact: true });
      await expect(months).toHaveAttribute("href", `/metas/${goalId}/meses`);
      await expect(page.getByRole("link", { name: "Ver por semana", exact: true })).toHaveAttribute(
        "href",
        `/metas/${goalId}/revision`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a measure with no amount says so and offers to plan the month; no measure draws its tasks, not an amount (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const bare = await seedGoal(db, person, { name: `Meta sin monto ${stamp}`, budget: null });
    await quantity(db, person, bare, 100, monthStart);
    const noMeasure = await seedGoal(db, person, { name: `Meta sin medida ${stamp}`, budget: null, unit: null });

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${bare}`);
      await expect(seen(page, monthName)).toHaveCount(1);
      await expect(seen(page, "1 h 40 min")).toHaveCount(2);
      await expect(visible(page, /sin monto planeado/)).toHaveCount(1);
      // No amount, so no percentage and no pace, whatever the day.
      await expect(visible(page, /llevas \d+ %|bajo el 60 %/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: `Planear ${monthName}`, exact: true })).toHaveAttribute(
        "href",
        `/metas/${bare}/meses?planear=${today.slice(0, 7)}&volver=${encodeURIComponent(`/metas/${bare}`)}`,
      );
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute(
        "href",
        `/metas/${bare}/meses`,
      );

      // The month section of a goal with no measure is `MetaSinMedida.dc.html`'s:
      // no figure and no amount, only its tasks and the way to its months.
      await page.goto(`/metas/${noMeasure}`);
      await expect(page.getByText(`Meta sin medida ${stamp}`).first()).toBeVisible();
      await expect(seen(page, "esta meta no mide nada")).toHaveCount(1);
      // RP-73 (`MetaSinTareas`): no task this month, so no month section and no «0 tareas»; «Ver por mes» stays.
      await expect(seen(page, monthName)).toHaveCount(0);
      await expect(visible(page, /0 tareas/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute(
        "href",
        `/metas/${noMeasure}/meses`,
      );
      await expect(visible(page, /sin monto planeado/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^Planear /})).toHaveCount(0);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a month budgeted at zero shows its figure and months link, but no bar and no pace (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const zero = await seedGoal(db, person, { name: `Meta cero ${stamp}`, budget: 0 });
    await quantity(db, person, zero, 90, monthStart);

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${zero}`);
      await expect(seen(page, monthName)).toHaveCount(1);
      await expect(seen(page, "1 h 30 min de 0 min")).toHaveCount(1);
      await expect(page.locator("span[aria-hidden][class] > span[style*=\"inline-size\"]")).toHaveCount(0);
      await expect(visible(page, /llevas \d+ %|bajo el 60 %/)).toHaveCount(0);
      await expect(visible(page, /sin monto planeado/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute(
        "href",
        `/metas/${zero}/meses`,
      );
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("an archived or ended goal reads its month and offers no way to plan it (RP-28)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const archived = await seedGoal(db, person, { name: `Meta archivada ${stamp}`, budget: 720, archived: true });
    await quantity(db, person, archived, 300, monthStart);
    const archivedBare = await seedGoal(db, person, {
      name: `Meta archivada sin monto ${stamp}`,
      budget: null,
      archived: true,
    });
    // The horizon is the first day after the goal, so on the 1st an ended goal
    // has no day in this month and draws no block.
    const ended = await seedGoal(db, person, { name: `Meta terminada ${stamp}`, budget: null, horizon: today });

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${archived}`);
      await expect(seen(page, "5 h")).toHaveCount(2);
      await expect(seen(page, "5 h de 12 h")).toHaveCount(late ? 0 : 1);
      if (late) await expect(seen(page, `día ${day} · 5 h de 12 h, bajo el 60 %`)).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toBeVisible();

      await page.goto(`/metas/${archivedBare}`);
      await expect(visible(page, /sin monto planeado/)).toHaveCount(1);
      await expect(page.getByRole("link", { name: /^Planear /})).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toBeVisible();

      await page.goto(`/metas/${ended}`);
      await expect(page.getByText(/^terminó el /)).toBeVisible();
      await expect(page.getByRole("link", { name: /^Planear /})).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveCount(day === 1 ? 0 : 1);
      await expect(visible(page, /sin monto planeado/)).toHaveCount(day === 1 ? 0 : 1);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a goal with no measure opens its months, its current month and the task form with no time field (RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const bare = await seedGoal(db, person, { name: `Meta libre ${stamp}`, budget: null, unit: null });
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${bare}, ${`Hecha ${stamp}`}, ${monthStart}::date) returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${bare}, ${done.id}, ${monthStart}::date)
    `;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${bare}, ${`Falta ${stamp}`}, ${monthStart}::date)
    `;

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${bare}`);
      await expect(seen(page, monthName)).toHaveCount(1);
      await expect(seen(page, "2 tareas · 1 hecha")).toHaveCount(1);
      await page.getByRole("link", { name: "Ver por mes", exact: true }).click();
      await expect(page).toHaveURL(`/metas/${bare}/meses`);
      await page.locator("main ol a", { hasText: monthName }).first().click();
      await expect(page).toHaveURL(`/metas/${bare}/meses/${today.slice(0, 7)}`);
      await expect(page.getByText(`Hecha ${stamp}`)).toBeVisible();
      await page.getByRole("link", { name: /^Otra tarea de /}).click();
      await expect(page.getByLabel("qué hay que hacer")).toBeVisible();
      await expect(page.getByLabel("horas")).toHaveCount(0);
      await expect(page.getByLabel("minutos")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// `MetaRitmoTareas.dc.html` (module 676): the row counts the month's tasks, never its time.
function line(done: number, total: number): string {
  return `Ritmo 12 h al mes · en ${monthName}, ${done} de ${total} tareas hechas`;
}

// `MetaVerPlan.dc.html` (RP-50): the goal leads to its plan with one link row —
// the plan's end, the rhythm and the month's part. Tasks are in the plan by
// `in_plan`; the end the row says is the plan's, never read here.
async function task(
  db: postgres.Sql,
  person: Person,
  goalId: string,
  name: string,
  estimate: number,
  doneOn: string | null,
  parentId: string | null = null,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, parent_id)
    values (${person.id}, ${goalId}, ${name}, ${estimate}, true, ${parentId}) returning id
  `;
  if (doneOn) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goalId}, ${row.id}, ${doneOn}::date)
    `;
  }
  return row.id;
}

test("a goal with a rhythm leads to its plan: «el plan», the end, the rhythm and the month's part, one link, no shift line (RP-50)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const id = await seedGoal(db, person, { name: `Meta plan ${stamp}`, budget: null, horizon: plusDays(900) });
    await db`update goals.goals set rhythm = 720 where id = ${id}`;
    await task(db, person, id, `Hecha ${stamp}`, 180, today);
    // A done sub-task does not make its parent a done task: «1 de 2», the parent is one task.
    const parent = await task(db, person, id, `Padre ${stamp}`, 600, null);
    await task(db, person, id, `Hija hecha ${stamp}`, 120, today, parent);
    await task(db, person, id, `Hija falta ${stamp}`, 480, null, parent);

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${id}`);
      await expect(seen(page, "el plan")).toHaveCount(1);
      const row = page.locator(`a[href="/metas/${id}/plan"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/^A este ritmo terminas el \d+ de \p{L}+/u);
      await expect(row).toContainText(line(1, 2));
      await expect(page.getByText(/arrastró \d+ %/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "ver qué se corre" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      // A white bordered card: 1px border, radius 10, 56 tall at least.
      const box = await row.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          border: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          height: el.getBoundingClientRect().height,
        };
      });
      expect(box.border, `border at ${width}`).toBe("1px");
      expect(box.radius, `radius at ${width}`).toBe("10px");
      expect(box.height, `height at ${width}`).toBeGreaterThanOrEqual(56);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a goal with tasks and no rhythm reads «Armar el plan» with no second line; one with no task in the plan has no «el plan» section (RP-50)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const bare = await seedGoal(db, person, { name: `Meta sin ritmo ${stamp}`, budget: null });
    await task(db, person, bare, `Falta ${stamp}`, 600, null);
    const empty = await seedGoal(db, person, { name: `Meta vacía ${stamp}`, budget: null });
    await db`update goals.goals set rhythm = 720 where id = ${empty}`;

    await page.goto(`/metas/${bare}`);
    const row = page.locator(`a[href="/metas/${bare}/plan"]`);
    await expect(row).toHaveText("Armar el plan");
    await page.goto(`/metas/${empty}`);
    await expect(seen(page, "el plan")).toHaveCount(0);
    await expect(page.locator(`a[href="/metas/${empty}/plan"]`)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
