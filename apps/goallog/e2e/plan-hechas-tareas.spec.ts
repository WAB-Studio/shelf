import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test as base, expect } from "./fixtures";

// `MetaPlanHechas.dc.html` and `RoadmapMesCifras.dc.html` (RP-50,
// RP-52, RP-28): the plan's «hechas» says it counts tasks done. The goal's
// row says it in tasks, not time (`MetaRitmoTareas.dc.html`, module 676):
// «Ritmo 12 h al mes · en octubre, 0 de 4 tareas hechas». Since module 688 the
// plan's month header says it the same way («1 de 3 tareas hechas»), by the
// same count: `planMonthList` of the month. The words are
// the approved boards' own, quoted here as literals, never read from the
// catalogue: a catalogue edit is what this spec exists to catch.

const test = base.extend<{ mine: Page }>({
  mine: async ({ browser, baseURL, person, viewport }, provide) => {
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: viewport ?? { width: 390, height: 844 },
    });
    await provide(await context.newPage());
    await context.close();
  },
});

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const today = todayInZone();
const thisYear = today.slice(0, 4);
const m0 = monthOf(today);
const m1 = nextMonth(m0);
const horizon = `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`;
const monthName = NAMES[Number(today.slice(5, 7)) - 1];
const nameOf = (month: string) =>
  month.slice(0, 4) === thisYear ? NAMES[Number(month.slice(5, 7)) - 1] : `${NAMES[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;

type Db = postgres.Sql;

async function seedGoal(db: Db, personId: string, rhythm: number | null, unit: string | null = "minutos"): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta hechas ${Date.now()}`}, ${horizon}::date, ${unit}, ${unit}, ${rhythm}, now() - interval '40 days')
    returning id`;
  return goal.id;
}

async function seedTask(db: Db, personId: string, goalId: string, name: string, estimate: number, done: boolean, position: number) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
    values (${personId}, ${goalId}, ${name}, ${estimate}, ${position}, true) returning id`;
  if (done) {
    await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goalId}, ${task.id}, ${today}::date)`;
  }
}

async function drop(db: Db, personId: string, goalId: string) {
  await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.commitments where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

const current = (page: Page) =>
  page.locator("section").filter({ has: page.getByText(`${monthName} · en curso`, { exact: true }) });
const later = (page: Page) =>
  page.locator("section").filter({ has: page.getByText(nameOf(m1), { exact: true }) });
const planRow = (page: Page, goalId: string) => page.locator(`a[href="/metas/${goalId}/plan"]`);
const family = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).fontFamily);

async function figuresMono(line: Locator, count: number) {
  expect(await family(line)).not.toMatch(/mono/i);
  const figures = line.locator("> span");
  await expect(figures).toHaveCount(count);
  for (let i = 0; i < count; i++) expect(await family(figures.nth(i))).toMatch(/mono/i);
}

for (const width of [390, 1440]) {
  test.describe(`405 at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the current month header counts tasks («2 de 3 tareas hechas»), never time; the goal's row says it too, figures mono, words Archivo", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Hecha 3", 180, true, 1);
        await seedTask(db, person.id, goalId, "Hecha 2", 120, true, 2);
        await seedTask(db, person.id, goalId, "Pendiente", 240, false, 3);

        await page.goto(`/metas/${goalId}/plan`);
        const header = current(page).getByText("2 de 3 tareas hechas", { exact: true });
        await expect(header).toBeVisible();
        await figuresMono(header, 2);
        await expect(page.getByText(/\d hechas de/)).toHaveCount(0);
        await expect(page.getByText(/en tareas hechas/)).toHaveCount(0);
        await expect(current(page)).not.toContainText("5 h");

        await page.goto(`/metas/${goalId}`);
        const rhythm = planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 2 de 3 tareas hechas`, { exact: true });
        await expect(rhythm).toBeVisible();
        await figuresMono(rhythm, 3);
        await expect(planRow(page, goalId)).not.toContainText("en tareas hechas");
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a later month keeps «planeadas de»; the current one is never said as planned", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Hecha", 300, true, 1);
        await seedTask(db, person.id, goalId, "Grande", 2400, false, 2);
        await page.goto(`/metas/${goalId}/plan`);
        await expect(later(page).getByText("12 h planeadas de 12 h", { exact: true })).toBeVisible();
        await expect(later(page).getByText(/tareas? hechas?/)).toHaveCount(0);
        await expect(current(page).getByText(/planeadas de/)).toHaveCount(0);
        await expect(current(page).getByText("1 de 2 tareas hechas", { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("nothing done: the header says «0 de 4 tareas hechas», never «0 min»; the row says «0 de 4 tareas hechas», never «0 min»", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        for (let i = 1; i <= 4; i++) await seedTask(db, person.id, goalId, `Pendiente ${i}`, 120, false, i);
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("0 de 4 tareas hechas", { exact: true })).toBeVisible();
        await expect(current(page)).not.toContainText("0 min");
        await page.goto(`/metas/${goalId}`);
        const row = planRow(page, goalId);
        await expect(row.getByText(`Ritmo 12 h al mes · en ${monthName}, 0 de 4 tareas hechas`, { exact: true })).toBeVisible();
        await expect(row).not.toContainText("0 min");
        await expect(row).not.toContainText("en tareas hechas");
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("marking one done moves the row to «1 de 4»; a task done last month is neither counted nor listed", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        for (let i = 1; i <= 4; i++) await seedTask(db, person.id, goalId, `Tarea ${i}`, 120, false, i);
        const [old] = await db<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
          values (${person.id}, ${goalId}, 'Hecha el mes pasado', 60, 0, true) returning id`;
        await db`insert into goals.facts (user_id, goal_id, one_off_id, day)
          values (${person.id}, ${goalId}, ${old.id}, (${m0}::date - interval '1 day')::date)`;
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 0 de 4 tareas hechas`, { exact: true })).toBeVisible();

        const [first] = await db<{ id: string }[]>`select id from goals.one_offs where goal_id = ${goalId} and name = 'Tarea 1'`;
        await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${first.id}, ${today}::date)`;
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 1 de 4 tareas hechas`, { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("one task in the month reads in the singular: «0 de 1 tarea hecha»", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Única", 120, false, 1);
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 0 de 1 tarea hecha`, { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a task split across months counts once: two small tasks and a 30 h one, one done, read «1 de 3»", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Corta 1", 120, true, 1);
        await seedTask(db, person.id, goalId, "Corta 2", 120, false, 2);
        await seedTask(db, person.id, goalId, "Partida", 1800, false, 3);
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 1 de 3 tareas hechas`, { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a month with one task reads in the singular on the plan: «0 de 1 tarea hecha»", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Única", 120, false, 1);
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("0 de 1 tarea hecha", { exact: true })).toBeVisible();
        await expect(page.getByText(/1 tareas/)).toHaveCount(0);
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a task split across months counts once in the header: «1 de 3 tareas hechas», as the goal's row", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Corta 1", 120, true, 1);
        await seedTask(db, person.id, goalId, "Corta 2", 120, false, 2);
        await seedTask(db, person.id, goalId, "Partida", 1800, false, 3);
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("1 de 3 tareas hechas", { exact: true })).toBeVisible();
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 1 de 3 tareas hechas`, { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a task carried over from last month counts in the header, undone or done", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        const lastMonth = `${monthOf(dayBefore(m0)).slice(0, 7)}-01`;
        await db`insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
          values (${person.id}, ${goalId}, 'Arrastrada pendiente', 60, 1, true, ${lastMonth}::date)`;
        const [done] = await db<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
          values (${person.id}, ${goalId}, 'Arrastrada hecha', 60, 2, true, ${lastMonth}::date) returning id`;
        await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${done.id}, ${today}::date)`;
        await seedTask(db, person.id, goalId, "Propia", 60, false, 3);
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 1 de 3 tareas hechas`, { exact: true })).toBeVisible();
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("1 de 3 tareas hechas", { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("a parent is not done by one done child: «0 de 2»; when every child is done it is: «1 de 2»", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        const [parent] = await db<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, name, position, in_plan)
          values (${person.id}, ${goalId}, 'Madre', 1, true) returning id`;
        const kids: string[] = [];
        for (const name of ["Hija 1", "Hija 2"]) {
          const [kid] = await db<{ id: string }[]>`
            insert into goals.one_offs (user_id, goal_id, name, estimate, position, parent_id)
            values (${person.id}, ${goalId}, ${name}, 60, 1, ${parent.id}) returning id`;
          kids.push(kid.id);
        }
        await seedTask(db, person.id, goalId, "Suelta", 60, false, 2);
        await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${kids[0]}, ${today}::date)`;
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("0 de 2 tareas hechas", { exact: true })).toBeVisible();
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 0 de 2 tareas hechas`, { exact: true })).toBeVisible();

        await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${kids[1]}, ${today}::date)`;
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("1 de 2 tareas hechas", { exact: true })).toBeVisible();
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("every month of the plan keeps its own measure: the current counts tasks, a later one hours planned, none counts tasks by the wrong month", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Hecha", 120, true, 1);
        await seedTask(db, person.id, goalId, "Pendiente", 120, false, 2);
        await db`insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
          values (${person.id}, ${goalId}, 'Fijada adelante', 600, 3, true, ${`${m1.slice(0, 7)}-01`}::date)`;
        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("1 de 2 tareas hechas", { exact: true })).toBeVisible();
        await expect(later(page).getByText("10 h planeadas de 12 h", { exact: true })).toBeVisible();
        await expect(page.getByText(/tareas? hechas?/)).toHaveCount(1);
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("no task in the month: the row says «Ritmo 12 h al mes» and nothing else", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await db`insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
          values (${person.id}, ${goalId}, 'Más adelante', 120, 1, true, ${`${m1.slice(0, 7)}-01`}::date)`;
        await page.goto(`/metas/${goalId}`);
        const row = planRow(page, goalId);
        await expect(row.getByText("Ritmo 12 h al mes", { exact: true })).toBeVisible();
        await expect(row).not.toContainText("tareas");
        await expect(row).not.toContainText(" · en ");
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("the month block keeps its own measure: «4 h 15 min de 12 h» while the row counts tasks", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        for (let i = 1; i <= 4; i++) await seedTask(db, person.id, goalId, `Tarea ${i}`, 120, false, i);
        const [commitment] = await db<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
          values (${person.id}, ${goalId}, ${`Sesión ${Date.now()}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
          returning id`;
        await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${person.id}, ${goalId}, ${commitment.id}, ${today}::date, 255)`;
        await page.goto(`/metas/${goalId}`);
        const block = page.locator("section").filter({ has: page.getByText(monthName, { exact: true }) }).filter({ hasText: /4 h 15 min/ });
        await expect(block.first()).toContainText("4 h 15 min");
        await expect(block.first()).toContainText("12 h");
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 0 de 4 tareas hechas`, { exact: true })).toBeVisible();
        await expect(planRow(page, goalId)).not.toContainText("4 h 15 min");
      } finally {
        await drop(db, person.id, goalId);
      }
    });

    test("the figure counts tasks, never facts: a 2 h fact is all «lo medido» holds, the done tasks' estimates adding none (RP-128), and neither the header nor the row moves", async ({ mine: page, db, person }) => {
      const goalId = await seedGoal(db, person.id, 720);
      try {
        await seedTask(db, person.id, goalId, "Hecha 3", 180, true, 1);
        await seedTask(db, person.id, goalId, "Hecha 2", 120, true, 2);
        await seedTask(db, person.id, goalId, "Pendiente", 240, false, 3);
        const [commitment] = await db<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
          values (${person.id}, ${goalId}, ${`Sesión ${Date.now()}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
          returning id`;
        await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${person.id}, ${goalId}, ${commitment.id}, ${today}::date, 120)`;

        await page.goto(`/metas/${goalId}/plan`);
        await expect(current(page).getByText("2 de 3 tareas hechas", { exact: true })).toBeVisible();
        await page.goto(`/metas/${goalId}`);
        await expect(planRow(page, goalId).getByText(`Ritmo 12 h al mes · en ${monthName}, 2 de 3 tareas hechas`, { exact: true })).toBeVisible();
        const measured = page.locator("section").filter({ has: page.getByText(monthName, { exact: true }) }).filter({ hasText: /2 h de 12 h/ });
        await expect(measured.first()).toBeVisible();
        await expect(measured.first()).not.toContainText("tareas hechas");
      } finally {
        await drop(db, person.id, goalId);
      }
    });
  });
}

test.describe("405 at 360", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("«1 de 2 tareas hechas» fits on the header and «1 de 2 tareas hechas» on the row", async ({ mine: page, db, person }) => {
    const goalId = await seedGoal(db, person.id, 7200);
    try {
      await seedTask(db, person.id, goalId, "Hecha larga", 750, true, 1);
      await seedTask(db, person.id, goalId, "Pendiente", 240, false, 2);
      await page.goto(`/metas/${goalId}/plan`);
      await expect(current(page).getByText("1 de 2 tareas hechas", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await page.goto(`/metas/${goalId}`);
      await expect(planRow(page, goalId).getByText(`Ritmo 120 h al mes · en ${monthName}, 1 de 2 tareas hechas`, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    } finally {
      await drop(db, person.id, goalId);
    }
  });
});

test("a goal with no measure draws no «tareas hechas» on its plan", async ({ mine: page, db, person }) => {
  const goalId = await seedGoal(db, person.id, null, null);
  try {
    // A budget gives the month an amount; with no measure it still has no figure to say.
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goalId}, ${`${today.slice(0, 7)}-01`}::date, 720)`;
    await seedTask(db, person.id, goalId, "Hecha", 180, true, 1);
    await page.goto(`/metas/${goalId}/plan`);
    await expect(page.getByText("Hecha", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/tareas hechas/)).toHaveCount(0);
  } finally {
    await drop(db, person.id, goalId);
  }
});
