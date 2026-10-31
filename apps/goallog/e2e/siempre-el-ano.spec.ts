import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";

// DESIGN.md 2026-10-11: a date always carries its year, and a line that ends
// in a link carries no separator before it. Every row is seeded under this
// spec's own identity and deleted by id or by person in `finally`.

const today = todayInZone();
const year = Number(today.slice(0, 4));
const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

// ICU's Spanish, never the catalogue's list the screen reads.
function dayWords(day: string): string {
  const parts = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .formatToParts(civilDateToDate(day));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("weekday")} ${part("day")} de ${part("month")} de ${part("year")}`;
}

async function seedOpen(db: postgres.Sql, personId: string, name: string, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizon}::date, now() - interval '60 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, 'Compromiso', 'daily', 'tap', now() - interval '60 days')
  `;
  return goal.id;
}

async function seedEnded(db: postgres.Sql, personId: string, name: string, lastDay: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${shift(lastDay, 1)}, now() - interval '60 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, 'Compromiso', 'daily', 'tap', now() - interval '60 days')
  `;
  return goal.id;
}

// By goal id: other specs share this identity while they run.
async function drop(db: postgres.Sql, goalIds: string[]) {
  await db`delete from goals.month_budgets where goal_id in ${db(goalIds)}`;
  await db`delete from goals.one_offs where goal_id in ${db(goalIds)}`;
  await db`delete from goals.commitments where goal_id in ${db(goalIds)}`;
  await db`delete from goals.goals where id in ${db(goalIds)}`;
}

async function open(page: Page, path: string) {
  await visit(page, path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test("the first rhythm's preview names the year even when it is this one", async ({ page, db, personId }) => {
  // Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta año ${Date.now()}`}, ${`${year + 1}-${today.slice(5, 7)}-01`}::date, 'minutos', 'minutos', null, date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota')
    returning id
  `;
  for (let index = 1; index <= 5; index++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${`Tarea ${index}`}, 240, ${index}, true)
    `;
  }
  try {
    // 20 h at 20 h a month end this month, in this year.
    await page.goto(`/metas/${goal.id}/plan`);
    await page.getByRole("radio", { name: "20 h" }).click();
    const end = monthOf(today);
    const spoken = `${monthFormat.format(new Date(`${end}T12:00:00Z`))} de ${end.slice(0, 4)}`;
    expect(end.slice(0, 4)).toBe(String(year));
    await expect(page.getByText(`tus 20 h de tareas terminan en ${spoken}.`, { exact: false })).toBeVisible();
    // 12 h a month ends next month: the year of that month, always written.
    await page.getByRole("radio", { name: "12 h" }).click();
    const next = nextMonth(monthOf(today));
    const spokenNext = `${monthFormat.format(new Date(`${next}T12:00:00Z`))} de ${next.slice(0, 4)}`;
    await expect(page.getByText(`tus 20 h de tareas terminan en ${spokenNext}.`, { exact: false })).toBeVisible();
  } finally {
    await drop(db, [goal.id]);
  }
});

test("/metas names the year of an end date in this year", async ({ page, db, personId }) => {
  const name = `Cierra este año ${Date.now()}`;
  const goalId = await seedOpen(db, personId, name, `${year + 1}-01-01`);
  try {
    await open(page, "/metas");
    // A goal is a card (DESIGN «Naranja y marino»): its weeks left and its end sit in the card, its link only opens it.
    const card = page.locator("section").filter({ has: page.getByRole("link", { name: new RegExp(name) }) }).last();
    await expect(card).toContainText(`hasta el 31 dic ${year}`);
  } finally {
    await drop(db, [goalId]);
  }
});

test("Hoy's «terminó» line ends at the words, with no separator before «ver»", async ({ page, db, personId }) => {
  test.skip(new Date(`${today}T12:00:00Z`).getUTCDay() === 1, "el lunes la línea de ayer no existe (su semana ya pasó)");
  const name = `Meta fin ${Date.now()}`;
  const openId = await seedOpen(db, personId, `Abierta ${Date.now()}`, shift(today, 60));
  const endedId = await seedEnded(db, personId, name, shift(today, -1));
  try {
    await open(page, "/");
    await expect(page.getByText(`${name} terminó ayer`, { exact: true })).toHaveCount(1);
    await expect(page.getByText(/terminó ayer ·/)).toHaveCount(0);
  } finally {
    await drop(db, [openId, endedId]);
  }
});

test("Semana's «terminó» line ends at the words, with no separator before «ver»", async ({ page, db, personId }) => {
  test.skip(new Date(`${today}T12:00:00Z`).getUTCDay() === 1, "el lunes la línea no existe (la meta terminó la semana pasada)");
  const name = `Meta fin ${Date.now()}`;
  const lastDay = shift(today, -1);
  const openId = await seedOpen(db, personId, `Abierta ${Date.now()}`, shift(today, 60));
  const endedId = await seedEnded(db, personId, name, lastDay);
  try {
    await open(page, "/semana");
    await expect(page.getByText(`terminó el ${dayWords(lastDay)}`, { exact: true }).filter({ visible: true })).toHaveCount(1);
  } finally {
    await drop(db, [openId, endedId]);
  }
});

async function seedDated(db: postgres.Sql, personId: string, name: string, createdAt: string, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizon}::date, ${new Date(`${createdAt}T17:00:00Z`)}) returning id
  `;
  return goal.id;
}

test("a goal's page names the year it was opened and the year it ended", async ({ page, db, personId }) => {
  const old = await seedDated(db, personId, `Viejo reto ${Date.now()}`, "2025-10-20", "2025-11-21");
  const long = await seedDated(db, personId, `Año largo ${Date.now()}`, "2025-12-24", "2028-01-01");
  try {
    await open(page, `/metas/${old}`);
    await expect(page.getByText("meta · abierta el 20 de octubre de 2025", { exact: true })).toBeVisible();
    await expect(page.getByText("terminó el jueves 20 de noviembre de 2025", { exact: true })).toBeVisible();
    await open(page, `/metas/${long}`);
    await expect(page.getByText("meta · abierta el 24 de diciembre de 2025", { exact: true })).toBeVisible();
  } finally {
    await drop(db, [old, long]);
  }
});

test("/metas names the year of an ended goal's last day", async ({ page, db, personId }) => {
  const name = `Viejo reto ${Date.now()}`;
  const id = await seedDated(db, personId, name, "2025-10-20", "2025-11-21");
  try {
    await open(page, "/metas");
    await expect(page.getByRole("link", { name: new RegExp(`^${name}`) })).toContainText("terminó el 20 nov 2025");
  } finally {
    await drop(db, [id]);
  }
});

test("Hoy's and Semana's «terminó» line names the month and the year", async ({ page, db, personId }) => {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  test.skip(weekday === 1 || weekday === 2, "lunes y martes dos días atrás cae en la semana pasada");
  const name = `Meta fin ${Date.now()}`;
  const lastDay = shift(today, -2);
  const openId = await seedOpen(db, personId, `Abierta ${Date.now()}`, shift(today, 60));
  const endedId = await seedEnded(db, personId, name, lastDay);
  try {
    await open(page, "/");
    await expect(page.getByText(`${name} terminó el ${dayWords(lastDay)}`, { exact: true })).toHaveCount(1);
    await open(page, "/semana");
    await expect(page.getByText(`terminó el ${dayWords(lastDay)}`, { exact: true }).filter({ visible: true })).toHaveCount(1);
  } finally {
    await drop(db, [openId, endedId]);
  }
});
