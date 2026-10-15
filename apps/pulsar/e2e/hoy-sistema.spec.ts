import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// Hoy: the marks of «este mes» stand on
// the same edge as the day's rows and its groups are spaced as sections; an
// ended goal's line is a sentence in Archivo and the lines stand together;
// refusals and notes are sentences, never mono.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const monthStart = `${today.slice(0, 7)}-01`;
// 0 is Monday: an ended goal's line draws from Tuesday on.
const todayIndex = (civilDateToDate(today).getUTCDay() + 6) % 7;

async function seedGoal(db: postgres.Sql, personId: string, name: string, tasks: string[]) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${shift(today, 90)}, now() - interval '40 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${`Tocar ${name}`}, 'daily', 'tap', now() - interval '40 days')
  `;
  for (const [index, task] of tasks.entries()) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
      values (${personId}, ${goal.id}, ${task}, ${monthStart}::date, ${index + 1})
    `;
  }
  return goal.id;
}

test("at 360 the marks of «este mes» stand on the day's rows' edge", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const first = `Primera ${stamp}`;
  const second = `Segunda ${stamp}`;
  await seedGoal(db, person.id, first, [`Tarea A ${stamp}`]);
  await seedGoal(db, person.id, second, [`Tarea B ${stamp}`]);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true").last();
    await expect(block.getByRole("button", { name: `Marcar hecha: Tarea A ${stamp}` })).toBeVisible();
    // The ring each mark draws, never the button around it.
    const edge = async (name: string) => {
      const box = await page
        .getByRole("button", { name })
        .locator("visible=true")
        .first()
        .locator('[data-part="mark"]')
        .first()
        .boundingBox();
      return box!.x;
    };
    const rowEdge = await edge(`Tocar ${first}`);
    expect(await edge(`Marcar hecha: Tarea A ${stamp}`)).toBeCloseTo(rowEdge, 0);
    expect(await edge(`Marcar hecha: Tarea B ${stamp}`)).toBeCloseTo(rowEdge, 0);

  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("at 360 the goal groups of «este mes» stand a section apart", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const first = `Primera ${stamp}`;
  const second = `Segunda ${stamp}`;
  await seedGoal(db, person.id, first, [`Tarea A ${stamp}`]);
  await seedGoal(db, person.id, second, [`Tarea B ${stamp}`]);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true").last();
    await expect(block.getByRole("button", { name: `Marcar hecha: Tarea A ${stamp}` })).toBeVisible();
    const a = (await boxOf(block.getByText(first, { exact: true })));
    const b = (await boxOf(block.getByText(second, { exact: true })));
    const taskA = (await boxOf(block.getByRole("button", { name: `Marcar hecha: Tarea A ${stamp}` })));
    expect(a.y).toBeLessThan(b.y);
    // The ghost button's own margin takes a few px of the 32 the group gap sets.
    expect(b.y - (taskA.y + taskA.height)).toBeGreaterThanOrEqual(28);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("an ended goal's lines are sentences in Archivo and stand together", async ({ person, browser, baseURL, db }) => {
  test.skip(todayIndex === 0, "on a Monday yesterday's week is over and no line draws");
  const stamp = Date.now();
  await seedGoal(db, person.id, `Abierta ${stamp}`, []);
  const ended = [`Terminada uno ${stamp}`, `Terminada dos ${stamp}`];
  for (const name of ended) {
    await db`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${name}, ${today}, now() - interval '60 days')
    `;
  }
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const line = (name: string) => page.getByText(name).locator("visible=true").first();
    await expect(line(ended[0])).toBeVisible();
    const family = await line(ended[0]).evaluate((node) => getComputedStyle(node).fontFamily);
    expect(family).not.toMatch(/mono/i);
    const one = (await boxOf(line(ended[0])));
    const two = (await boxOf(line(ended[1])));
    // One block: the lines are a link's height apart, never a section's worth of air.
    expect(Math.abs(two.y - one.y)).toBeLessThanOrEqual(56);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("a day's one-off that gained sub-tasks refuses «hecha» in a sentence, in Archivo", async ({ person, browser, baseURL, db }) => {
  const name = `Suelta con hijas ${Date.now()}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${person.id}, ${`Meta ${name}`}, ${shift(today, 90)}) returning id
  `;
  const [parent] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, in_plan)
    values (${person.id}, ${goal.id}, ${name}, ${today}::date, true) returning id
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("button", { name, exact: true }).locator("visible=true")).toHaveCount(1);
    const mark = page.getByRole("button", { name: "Marcar como hecho" }).locator("visible=true");
    await expect(mark).toHaveCount(1);
    // Landing after the page drew: the refusal is what the click meets.
    await db`
      insert into goals.one_offs (user_id, goal_id, name, parent_id, in_plan)
      values (${person.id}, ${goal.id}, ${`Hija ${name}`}, ${parent.id}, true)
    `;
    await mark.click();
    const refusal = page.getByText("Esta tarea se da por hecha cuando lo están sus sub-tareas.").locator("visible=true");
    await expect(refusal).toHaveCount(1);
    expect(await refusal.evaluate((node) => getComputedStyle(node).fontFamily)).not.toMatch(/mono/i);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
