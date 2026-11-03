import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-151: the time a task's clock records waits «por confirmar» and adds to no goal until the person gives it one.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

type Db = Parameters<Parameters<typeof test>[2]>[0]["db"];

async function seedGoal(db: Db, personId: string, name: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${plusDays(90)}, 'Tiempo', 'minutos', now() - interval '10 days') returning id
  `;
  return goal.id;
}

async function seedTask(db: Db, personId: string, goalId: string, name: string): Promise<string> {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, estimate)
    values (${personId}, ${goalId}, ${name}, ${todayInZone()}::date, 60) returning id
  `;
  return task.id;
}

async function allocated(db: Db, goalId: string): Promise<number> {
  const [row] = await db<{ minutes: number }[]>`
    select coalesce(sum(minutes), 0)::int as minutes from goals.time_allocations where goal_id = ${goalId}`;
  return row.minutes;
}

async function recordTwoHours(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "2 h", exact: true }).click();
  await sheet.getByRole("button", { name: "Anotar y alargar la tarea" }).click();
  await expect(sheet).toBeHidden();
}

test("2 h on a task's clock wait; confirming them for the goal adds 120 to its total (RP-151)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta horas ${stamp}`);
  const name = `Estudiar ${stamp}`;
  await seedTask(db, person.id, goalId, name);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await recordTwoHours(page, name);
    await expect(page.getByRole("button", { name: "Confirmar las horas que esperan" })).toContainText("1 entrada por confirmar · 2 h");

    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/2\s?h/)).toHaveCount(0);
    expect(await allocated(db, goalId)).toBe(0);

    await page.goto("/");
    await page.getByRole("button", { name: "Confirmar las horas que esperan" }).click();
    const tray = page.getByRole("dialog");
    await expect(tray.getByText(`De la tarea ${name}`)).toBeVisible();
    await tray.getByRole("button", { name: `Confirmar en Meta horas ${stamp}` }).click();
    await expect(tray).toBeHidden();
    expect(await allocated(db, goalId)).toBe(120);

    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/2\s?h/).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an entry is split 90/30 across two goals; the sum must be the entry's (RP-151)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const first = await seedGoal(db, person.id, `Primera ${stamp}`);
  const second = await seedGoal(db, person.id, `Segunda ${stamp}`);
  const name = `Estudiar ${stamp}`;
  await seedTask(db, person.id, first, name);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await recordTwoHours(page, name);
    await page.getByRole("button", { name: "Confirmar las horas que esperan" }).click();
    const tray = page.getByRole("dialog");
    await tray.getByRole("button", { name: "Repartir" }).click();

    await tray.getByLabel(`Minutos para Primera ${stamp}`).fill("90");
    await tray.getByLabel(`Minutos para Segunda ${stamp}`).fill("20");
    await expect(tray.getByText("Faltan 10 min")).toBeVisible();
    await expect(tray.getByRole("button", { name: "Confirmar reparto" })).toBeDisabled();

    await tray.getByLabel(`Minutos para Segunda ${stamp}`).fill("30");
    await tray.getByRole("button", { name: "Confirmar reparto" }).click();
    await expect(tray).toBeHidden();
    expect([await allocated(db, first), await allocated(db, second)]).toEqual([90, 30]);
  } finally {
    await context.close();
  }
});

test("«No cuenta» adds nothing and the entry leaves the tray (RP-151)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta horas ${stamp}`);
  const name = `Estudiar ${stamp}`;
  await seedTask(db, person.id, goalId, name);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await recordTwoHours(page, name);
    await page.getByRole("button", { name: "Confirmar las horas que esperan" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "No cuenta" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Confirmar las horas que esperan" })).toHaveCount(0);

    expect(await allocated(db, goalId)).toBe(0);
    const [entry] = await db<{ dismissed_at: string | null }[]>`select dismissed_at from goals.time_entries where user_id = ${person.id}`;
    expect(entry.dismissed_at).not.toBeNull();
  } finally {
    await context.close();
  }
});

test("time recorded again after a confirmation waits for the difference alone (RP-151)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta horas ${stamp}`);
  const name = `Estudiar ${stamp}`;
  const taskId = await seedTask(db, person.id, goalId, name);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await recordTwoHours(page, name);
    await page.getByRole("button", { name: "Confirmar las horas que esperan" }).click();
    await page.getByRole("dialog").getByRole("button", { name: `Confirmar en Meta horas ${stamp}` }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill("180");
    await sheet.getByRole("button", { name: "Anotar", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Confirmar las horas que esperan" })).toContainText("1 entrada por confirmar · 1 h");
    expect(await allocated(db, goalId)).toBe(120);

    // Under what was already placed is refused: the confirmation is undone first.
    await page.getByRole("button", { name: `Anotar el tiempo de ${name}` }).click();
    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill("100");
    await sheet.getByRole("button", { name: "Anotar", exact: true }).click();
    await expect(sheet.getByText("Ya diste a una meta parte de ese tiempo. Deshaz esa entrada primero.")).toBeVisible();
    const [spent] = await db<{ spent_minutes: number }[]>`select spent_minutes from goals.one_offs where id = ${taskId}`;
    expect(spent.spent_minutes).toBe(180);
  } finally {
    await context.close();
  }
});
