import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-147: marking a task estimated in time done asks how long it took, its estimate preselected; the time is the
// fact's quantity and counts in the goal's measure; over the estimate, «Anotar y alargar la tarea» also lengthens it.

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

test("a time over the estimate offers to lengthen the task; taken, the fact holds 120 and the estimate follows (RP-147)", async ({
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
    await page.getByRole("button", { name: `Marcar como hecho: ${name}` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("¿Cuánto te tomó?")).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "1 h" }).or(sheet.getByRole("button", { name: "1 h" })).first()).toBeVisible();
    const extend = sheet.getByRole("button", { name: "Anotar y alargar la tarea" });
    await expect(extend).toHaveCount(0);

    await sheet.getByRole("radio", { name: "2 h" }).or(sheet.getByRole("button", { name: "2 h" })).first().click();
    await expect(extend).toBeVisible();
    await extend.click();
    await expect(sheet).toBeHidden();

    const [fact] = await db<{ quantity: number }[]>`select quantity from goals.facts where one_off_id = ${taskId}`;
    const [task] = await db<{ estimate: number }[]>`select estimate from goals.one_offs where id = ${taskId}`;
    expect([fact.quantity, task.estimate]).toEqual([120, 120]);

    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/2\s?h/).first()).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the estimate as the answer offers only «Anotar»; the estimate stays (RP-147)", async ({ person, browser, baseURL, db }) => {
  const { goalId, taskId, name } = await seed(db, person.id, Date.now() + 1);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: `Marcar como hecho: ${name}` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Anotar y alargar la tarea" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Anotar", exact: true }).click();
    await expect(sheet).toBeHidden();

    const [fact] = await db<{ quantity: number }[]>`select quantity from goals.facts where one_off_id = ${taskId}`;
    const [task] = await db<{ estimate: number }[]>`select estimate from goals.one_offs where id = ${taskId}`;
    expect([fact.quantity, task.estimate]).toEqual([60, 60]);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
