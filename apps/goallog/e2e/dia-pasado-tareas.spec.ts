import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-129 on `/dia/<fecha>`: a past day draws the dated tasks it still owed
// and those done on it, tapped as on Hoy; a month task with no day stays on
// Hoy. Every name carries the run's stamp, so a shared person's other rows
// never answer an assertion, and each test drops what it seeded by id.

function pastDay(daysAgo: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return dateToCivilDate(date);
}

function stampAt(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 86_400_000);
}

// Monday is where `/semana?semana=` starts a week, as `weekOf` counts it.
function mondayOf(day: string): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return dateToCivilDate(date);
}

async function seedGoal(db: postgres.Sql, personId: string, name: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${pastDay(-60)}, ${stampAt(12)}) returning id
  `;
  return goal.id;
}

// `createdDaysAgo` is when the task came to exist: a day before it is refused.
async function seedTask(
  db: postgres.Sql,
  personId: string,
  task: { name: string; goalId: string | null; dayAgo: number | null; createdDaysAgo: number },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, created_at)
    values (
      ${personId}, ${task.goalId}, ${task.name},
      ${task.dayAgo === null ? null : pastDay(task.dayAgo)}, ${stampAt(task.createdDaysAgo)}
    ) returning id
  `;
  return row.id;
}

async function factDays(db: postgres.Sql, oneOffId: string): Promise<string[]> {
  const rows = await db<{ day: string }[]>`
    select day::text as day from goals.facts where one_off_id = ${oneOffId}
  `;
  return rows.map((row) => row.day);
}

function markOf(page: Page, name: string) {
  return page.getByRole("button", { name: `Marcar como hecho: ${name}` });
}

// The row's button, whose text carries «del …» when the task is carried.
function rowOf(page: Page, name: string) {
  return page.locator("button", { hasText: name });
}

function tallyOf(page: Page) {
  return page.getByText(/hechos \d+ de \d+/).first();
}

test("a task owed on yesterday is drawn under its goal with «del …», and a goal with only that task has its heading (RP-129, RP-06)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const goalName = `Meta solo tarea ${stamp}`;
  const name = `Tarea debida ${stamp}`;
  const goalId = await seedGoal(db, personId, goalName);
  const oneOffId = await seedTask(db, personId, { name, goalId, dayAgo: 2, createdDaysAgo: 5 });

  try {
    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByRole("main").getByText(goalName, { exact: true })).toBeVisible();
    await expect(rowOf(page, name)).toBeVisible();
    await expect(rowOf(page, name)).toContainText(/del \S+ \d+/);
    await expect(page.getByLabel("Algo suelto")).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("a goal-less task sits in «Sueltas» with no field and no link to the waiting ones (RP-129, RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const name = `Suelta debida ${stamp}`;
  const oneOffId = await seedTask(db, personId, { name, goalId: null, dayAgo: 1, createdDaysAgo: 4 });
  const waitingId = await seedTask(db, personId, { name: `Esperando ${stamp}`, goalId: null, dayAgo: null, createdDaysAgo: 4 });

  try {
    await page.goto(`/dia/${pastDay(1)}`);
    await expect(rowOf(page, name)).toBeVisible();
    await expect(page.getByLabel("Algo suelto")).toHaveCount(0);
    await expect(page.locator('a[href="/sueltas"]')).toHaveCount(0);
    await expect(page.getByText(`Esperando ${stamp}`)).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where id = any(${[oneOffId, waitingId]})`;
  }
});

test("a tap marks the task done on yesterday, off Hoy, in the Semana, and its undo returns it; the tally never counts it (RP-129, RP-06, RP-05)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const name = `Tarea tocada ${stamp}`;
  const goalId = await seedGoal(db, personId, `Meta tarea tocada ${stamp}`);
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goalId}, ${`Hábito ${stamp}`}, 'daily', 'tap', ${stampAt(10)})
  `;
  const oneOffId = await seedTask(db, personId, { name, goalId, dayAgo: 2, createdDaysAgo: 5 });
  const yesterday = pastDay(1);

  try {
    await page.goto(`/dia/${yesterday}`);
    const before = await tallyOf(page).textContent();
    await markOf(page, name).click();
    await expect(page.getByText("Hechas ese día")).toBeVisible();
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();
    await expect(markOf(page, name)).toHaveCount(0);
    await expect.poll(() => factDays(db, oneOffId)).toEqual([yesterday]);
    expect(await tallyOf(page).textContent()).toBe(before);

    await page.goto("/");
    await expect(rowOf(page, name)).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/semana?semana=${mondayOf(yesterday)}`);
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 360, height: 740 });

    await page.goto(`/dia/${yesterday}`);
    await page.getByRole("button", { name: `Deshacer: ${name}` }).click();
    await expect(markOf(page, name)).toBeVisible();
    await expect(page.getByText("Hechas ese día")).toHaveCount(0);
    await expect.poll(() => factDays(db, oneOffId)).toEqual([]);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the task's sheet on a past day offers no «Darle otro día», Hoy's does (RP-129, RP-61)", async ({ page, db, personId }) => {
  const name = `Tarea hoja ${Date.now()}`;
  const oneOffId = await seedTask(db, personId, { name, goalId: null, dayAgo: 2, createdDaysAgo: 4 });

  try {
    await page.goto("/");
    await rowOf(page, name).click();
    await expect(page.getByRole("dialog").getByText(/otro día/i)).toBeVisible();

    await page.goto(`/dia/${pastDay(1)}`);
    await rowOf(page, name).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/otro día/i)).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("the seventh day back marks a task dated then, and a task made today is absent from it (RP-129, RNP-07)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const edge = `Tarea del borde ${stamp}`;
  const later = `Tarea de hoy ${stamp}`;
  const edgeId = await seedTask(db, personId, { name: edge, goalId: null, dayAgo: 7, createdDaysAgo: 9 });
  const laterId = await seedTask(db, personId, { name: later, goalId: null, dayAgo: 0, createdDaysAgo: 0 });

  try {
    await page.goto(`/dia/${pastDay(7)}`);
    await expect(page.getByRole("button", { name: later, exact: true })).toHaveCount(0);
    await markOf(page, edge).click();
    await expect(page.getByRole("button", { name: `Deshacer: ${edge}` })).toBeVisible();
    await expect.poll(() => factDays(db, edgeId)).toEqual([pastDay(7)]);

    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByRole("button", { name: later, exact: true })).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where id = any(${[edgeId, laterId]})`;
  }
});

test("a task made after the day it names is refused with the server's text, and the row stays (RP-129)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Tarea nacida tarde ${Date.now()}`;
  // Dated three days back, made today: drawn on yesterday, refused there.
  const oneOffId = await seedTask(db, personId, { name, goalId: null, dayAgo: 3, createdDaysAgo: 0 });

  try {
    await page.goto(`/dia/${pastDay(1)}`);
    await markOf(page, name).click();
    await expect(page.getByText("Esa tarea todavía no existía ese día.")).toBeVisible();
    await expect(markOf(page, name)).toBeVisible();
    expect(await factDays(db, oneOffId)).toEqual([]);
  } finally {
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});

test("a month task with no day is not drawn on a past day, and a day with nothing still asks nothing (RP-129, RP-44)", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const name = `Tarea del mes ${stamp}`;
  // The empty line is asserted over the whole page, so the person is the worker's own.
  const context = await browser.newContext({ storageState: person.sessionFile });
  const oneOffId = await seedTask(db, person.id, { name, goalId: null, dayAgo: null, createdDaysAgo: 5 });

  try {
    const page = await context.newPage();
    await page.goto(`/dia/${pastDay(1)}`);
    await expect(page.getByText(name)).toHaveCount(0);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where id = ${oneOffId}`;
  }
});
