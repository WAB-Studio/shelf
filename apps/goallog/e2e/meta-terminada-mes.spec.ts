import type postgres from "postgres";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";
import month from "../messages/es/month.json";

// 821: after a goal's end nothing of it is «en curso» (docs/goallog/DESIGN.md,
// 2026-10-11). 822: a goal with a rhythm has a plan; `/meses` does not ask for
// an amount it never needs. `innerText` of `main` is what a person reads:
// hidden faces drop out, and the uppercase of a label arrives uppercased, so
// every pattern is case-insensitive.

const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function plusDays(from: string, days: number): string {
  const date = civilDateToDate(from);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const today = todayInZone();
const thisMonth = `${today.slice(0, 7)}-01`;
const monthEnd = dateToCivilDate(
  new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)),
);
// Ended «earlier this month». On the 1st there is no earlier day in the month:
// the goal then ended on the last day of the previous month, the month it
// lives in is that one, and the month-page checks follow it.
const endedOn = plusDays(today, -1);
const endedMonth = endedOn.slice(0, 7);
const endedMonthStart = `${endedMonth}-01`;

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  input: { name: string; horizon: string; rhythm?: number | null; budgetMonth?: string | null },
) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${input.name}, ${input.horizon}::date, 'minutos', 'minutos', ${input.rhythm ?? null}, now() - interval '40 days')
    returning id
  `;
  if (input.budgetMonth) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${personId}, ${goal.id}, ${input.budgetMonth}::date, 600)
    `;
  }
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

const mainText = async (page: import("@playwright/test").Page) => {
  await expect(page.locator("main")).toHaveCount(1);
  return (await page.locator("main").innerText()) ?? "";
};

test("821 · the month card of an ended goal has no «faltan»", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: endedMonthStart,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^terminó el /)).toBeVisible();
    expect(await mainText(page)).not.toMatch(/faltan|falta \d/i);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("821 · an open goal ending before the month's end counts «faltan» to its own last day", async ({
  page,
  db,
  personId,
}) => {
  // The horizon is the day after the goal's last day: «faltan» counts to that
  // last day, or to the month's end when it lies beyond it.
  const dow = (civilDateToDate(today).getUTCDay() + 6) % 7;
  const midNextWeek = plusDays(today, 7 - dow + 2);
  const lastDay = plusDays(midNextWeek, -1);
  const last = lastDay < monthEnd ? lastDay : monthEnd;
  const days = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  const goalId = await seedGoal(db, personId, {
    name: `Abierta ${Date.now()}`,
    horizon: midNextWeek,
    budgetMonth: thisMonth,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    const line = days === 1 ? "faltan 1 día" : `faltan ${days} días`;
    await expect(page.getByText(new RegExp(`llevas \\d+ % · ${line}$`))).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("821 · /meses of an ended goal shows no «en curso» and no «ESTE MES»", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: endedMonthStart,
  });
  try {
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.getByRole("heading", { name: month.months.title })).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain(NAMES[Number(endedMonth.slice(5, 7)) - 1]);
    expect(text).not.toMatch(/en curso/i);
    expect(text).not.toMatch(/este mes/i);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("821 · the month page of an ended goal reads «cerrado», says it takes nothing, and has no empty «TAREAS» heading", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: endedMonthStart,
  });
  try {
    await page.goto(`/metas/${goalId}/meses/${endedMonth}`);
    await expect(page.getByText(month.list.closedNote)).toBeVisible();
    const text = await mainText(page);
    expect(text).toMatch(new RegExp(`^${month.list.closed}$`, "im"));
    expect(text).not.toMatch(/en curso/i);
    expect(text).not.toMatch(/este mes/i);
    expect(text).not.toMatch(/^tareas$/im);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("822 · a goal with a rhythm and no month amount does not ask to plan on /meses", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, {
    name: `Ritmo ${Date.now()}`,
    horizon: plusDays(today, 120),
    rhythm: 480,
  });
  try {
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.getByRole("heading", { name: month.months.title })).toBeVisible();
    expect(await mainText(page)).not.toMatch(/Ningún mes tiene monto/i);
    await expect(page.getByRole("link", { name: /^Planear /i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Planear /i })).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("822 · a goal with neither rhythm nor amounts still asks to plan on /meses", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Sin ritmo ${Date.now()}`,
    horizon: plusDays(today, 120),
  });
  try {
    await page.goto(`/metas/${goalId}/meses`);
    const name = NAMES[Number(today.slice(5, 7)) - 1];
    await expect(page.getByText(/Ningún mes tiene monto/)).toBeVisible();
    await expect(page.getByRole("link", { name: `Planear ${name}`, exact: true })).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("821 · the month card of an ended goal keeps «llevas N %» and nothing after it", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: thisMonth,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^terminó el /)).toBeVisible();
    await expect(page.getByText(/^llevas \d+ %$/)).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});

test("821 · /meses at 1280 of an ended goal shows no «ESTE MES» beside the list", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: endedMonthStart,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.getByRole("heading", { name: month.months.title })).toBeVisible();
    const text = await mainText(page);
    expect(text).toContain(NAMES[Number(endedMonth.slice(5, 7)) - 1]);
    expect(text).not.toMatch(/en curso/i);
    expect(text).not.toMatch(/este mes/i);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("824 · «mover el final» of an ended goal is the lowercase link of an open one", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, {
    name: `Terminada ${Date.now()}`,
    horizon: endedOn,
    budgetMonth: endedMonthStart,
  });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByRole("button", { name: "mover el final", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mover el final", exact: true })).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("824 · the goal screen dates its end with the year even in this year", async ({ page, db, personId }) => {
  const year = today.slice(0, 4);
  const goalId = await seedGoal(db, personId, { name: `Este año ${Date.now()}`, horizon: `${year}-12-31` });
  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(new RegExp(`semanas · hasta el 30 dic ${year}$`))).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});
