import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import day from "../messages/es/day.json";

// Hoy's order and its phone face (`HoyTelefonoSinPedido.dc.html`,
// `HoyTareaMesSubtarea.dc.html`, RP-47, RP-01): goals that ask today come
// first, a goal that asks nothing has no section below 1024 and its «este
// mes» line stays, and a sub-task names its parent.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const monthStart = `${todayInZone().slice(0, 7)}-01`;

async function seedGoal(db: postgres.Sql, personId: string, name: string, createdAgo: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${plusDays(90)}, 'minutos', 'minutos', now() - ${createdAgo}::interval)
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goal.id}, ${monthStart}::date, 720)
  `;
  return goal.id;
}

test("a goal that asks nothing is below the one that asks at 1280 and has no section at 360, its «este mes» line staying (RP-47)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const quiet = `Meta quieta ${stamp}`;
  const asking = `Meta que pide ${stamp}`;
  // `quiet` is created first, so plan order alone would put it on top.
  const quietId = await seedGoal(db, person.id, quiet, "50 days");
  const askingId = await seedGoal(db, person.id, asking, "40 days");
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${askingId}, ${`Tocar ${stamp}`}, 'daily', 'tap', now() - interval '40 days')
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const field = (goal: string) => page.getByPlaceholder(day.newOneOff.placeholderForGoalShort.replace("{goal}", goal));
    const seen = (text: string) => page.getByText(text, { exact: true }).locator("visible=true");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(field(asking)).toBeVisible();
    await expect(field(quiet)).toBeVisible();
    const askingBox = await field(asking).boundingBox();
    const quietBox = await field(quiet).boundingBox();
    expect(askingBox!.y).toBeLessThan(quietBox!.y);

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    // The one task field of the day lives in «Sueltas»; no group draws its own.
    await expect(field(asking)).toBeHidden();
    await expect(field(quiet)).toBeHidden();
    await expect(page.getByPlaceholder("Escribe una tarea…")).toBeVisible();
    const sectionOf = (goal: string) =>
      page.locator("main").locator("[data-part='group-head'] h2", { hasText: new RegExp(`^${goal}$`) }).locator("visible=true");
    await expect(sectionOf(asking)).toHaveCount(1);
    await expect(sectionOf(quiet)).toHaveCount(0);
    // The month line of the goal with no section is still on screen.
    await expect(seen(quiet)).toHaveCount(1);
    await expect(seen("Este mes")).toHaveCount(1);

    // A one-off of its own makes it ask: its section is back.
    await db`
      insert into goals.one_offs (user_id, goal_id, name, day)
      values (${person.id}, ${quietId}, ${`Suelta propia ${stamp}`}, ${todayInZone()}::date)
    `;
    await page.reload();
    await expect(sectionOf(quiet)).toHaveCount(1);
  } finally {
    await context.close();
    await db`delete from goals.goals where id in (${quietId}, ${askingId}) and user_id = ${person.id}`;
  }
});

test("the next task of the month names its parent and its estimate stays on one line beside a two-line name (RP-01)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalName = `Meta subtarea ${stamp}`;
  const parent = `Evaluación del RAG ${stamp}`;
  const child = `Dataset dorado: escribir las 50 a 80 preguntas con su respuesta ${stamp}`;
  const goalId = await seedGoal(db, person.id, goalName, "40 days");
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goalId}, ${parent}, ${monthStart}::date) returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, parent_id, name, estimate)
    values (${person.id}, ${goalId}, ${task.id}, ${child}, 240)
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const line = page.getByRole("button", { name: `Marcar hecha: ${child}` }).locator("xpath=..");
    await expect(line).toBeVisible();
    await expect(line.getByText(`de ${parent}`, { exact: true })).toBeVisible();

    const name = await line.getByText(child, { exact: true }).boundingBox();
    const estimate = await line.getByText("4 h", { exact: true }).boundingBox();
    // The name wraps to at least two lines; the estimate keeps to one.
    expect(name!.height).toBeGreaterThanOrEqual(estimate!.height * 2);
    expect(estimate!.height).toBeLessThan(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
