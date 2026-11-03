import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-147: a task estimated in time keeps the minutes spent on it without being done; only the check completes it, and
// its fact then holds those minutes. They count in the goal's measure only once confirmed (RP-151).

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seed(db: Parameters<Parameters<typeof test>[2]>[0]["db"], personId: string, stamp: number) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Meta tiempo ${stamp}`}, ${plusDays(90)}, 'Tiempo', 'minutos', now() - interval '10 days') returning id
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, estimate)
    values (${personId}, ${goal.id}, ${`Estudiar ${stamp}`}, ${todayInZone()}::date, 60) returning id
  `;
  return { goalId: goal.id, taskId: task.id, name: `Estudiar ${stamp}` };
}

test("recording 2 h and lengthening keeps the task open; the check then completes it with 120 (RP-147)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const { goalId, taskId, name } = await seed(db, person.id, Date.now());
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("¿Cuánto te tomó?")).toBeVisible();
    const extend = sheet.getByRole("button", { name: "Anotar y alargar la tarea" });
    await expect(extend).toHaveCount(0);

    await sheet.getByRole("button", { name: "2 h", exact: true }).click();
    await expect(extend).toBeVisible();
    await extend.click();
    await expect(sheet).toBeHidden();

    const [open] = await db<{ spent_minutes: number; estimate: number }[]>`
      select spent_minutes, estimate from goals.one_offs where id = ${taskId}`;
    expect([open.spent_minutes, open.estimate]).toEqual([120, 120]);
    expect(await db`select 1 from goals.facts where one_off_id = ${taskId}`).toHaveLength(0);
    await expect(page.getByText("llevas 2 h de 2 h")).toBeVisible();
    await expect(page.getByRole("button", { name: `Marcar como hecho: ${name}` })).toBeVisible();

    await page.getByRole("button", { name: `Marcar como hecho: ${name}` }).click();
    await expect(page.getByRole("button", { name: `Marcar como hecho: ${name}` })).toHaveCount(0);
    const [fact] = await db<{ quantity: number }[]>`select quantity from goals.facts where one_off_id = ${taskId}`;
    expect(fact.quantity).toBe(120);

    // Done, the time still waits: the goal's total holds nothing until the person confirms it.
    const [waiting] = await db<{ minutes: number }[]>`select minutes from goals.time_entries where one_off_id = ${taskId}`;
    expect(waiting.minutes).toBe(120);
    await page.goto("/");
    await page.getByRole("button", { name: "Confirmar las horas que esperan" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Confirmar en Meta tiempo/ }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/2\s?h/).first()).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("recording within the estimate keeps the task open; «Marcar hecha» in the sheet completes with the time recorded (RP-147)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const { goalId, taskId, name } = await seed(db, person.id, Date.now() + 1);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "45 min", exact: true }).click();
    await sheet.getByRole("button", { name: "Anotar", exact: true }).click();
    await expect(sheet).toBeHidden();

    const [open] = await db<{ spent_minutes: number; estimate: number }[]>`
      select spent_minutes, estimate from goals.one_offs where id = ${taskId}`;
    expect([open.spent_minutes, open.estimate]).toEqual([45, 60]);
    expect(await db`select 1 from goals.facts where one_off_id = ${taskId}`).toHaveLength(0);

    await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Marcar hecha" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: `Marcar como hecho: ${name}` })).toHaveCount(0);
    const [fact] = await db<{ quantity: number }[]>`select quantity from goals.facts where one_off_id = ${taskId}`;
    expect(fact.quantity).toBe(45);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the mark of a task with no time recorded completes it at its estimate (RP-147)", async ({ person, browser, baseURL, db }) => {
  const { goalId, taskId, name } = await seed(db, person.id, Date.now() + 2);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: `Marcar como hecho: ${name}` }).click();
    await expect(page.getByRole("button", { name: `Marcar como hecho: ${name}` })).toHaveCount(0);
    const [fact] = await db<{ quantity: number }[]>`select quantity from goals.facts where one_off_id = ${taskId}`;
    expect(fact.quantity).toBe(60);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
