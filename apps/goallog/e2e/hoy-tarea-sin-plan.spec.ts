import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// `HoyTareaMesSinPlan` (RP-62): the next task of a goal measured in a unit that
// is not time reads «Siguiente del mes»; a goal in minutes and a goal with no
// measure keep «Siguiente del plan»; a task split across months keeps its share.

const letters = (n: number) => [...String(n)].map((digit) => String.fromCharCode(97 + Number(digit))).join("");

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  name: string,
  measure: { unit: string; rhythm: number } | null,
) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${name}, '2099-12-31'::date, ${measure?.unit ?? null}, ${measure?.unit ?? null},
            ${measure?.rhythm ?? null}, '2020-01-01T00:00:00Z'::timestamptz)
    returning id
  `;
  return goal.id;
}

async function planTask(db: postgres.Sql, personId: string, goalId: string, name: string, estimate: number | null) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
    values (${personId}, ${goalId}, ${name}, ${estimate}, true, 1, '2020-01-02T00:00:00Z'::timestamptz)
  `;
}

// The row of the task: the mark that completes it sits directly in the row.
function rowOf(page: Page, name: string): Locator {
  return page
    .getByRole("button", { name: new RegExp(`^Marcar (hecha|como hecho): ${name}$`) })
    .locator("visible=true")
    .locator("xpath=..");
}

for (const width of [390, 1440]) {
  test(`Hoy at ${width}: the next task of a goal in km reads «Siguiente del mes», never «del plan»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Comprar zapatillas ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Correr ${stamp}`, { unit: "kilómetros", rhythm: 40 });
    await planTask(db, person.id, goal, name, null);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText("Siguiente del mes", { exact: true }), "the board's line").toHaveCount(1);
      expect.soft(await row.innerText(), "no plan in a goal that has none").not.toContain("del plan");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: the next task of a goal in minutes reads «Siguiente del plan» and its «4 h»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Dataset dorado ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `IA aplicada ${stamp}`, { unit: "minutos", rhythm: 720 });
    await planTask(db, person.id, goal, name, 240);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText("Siguiente del plan", { exact: true })).toHaveCount(1);
      await expect.soft(row.getByText("4 h", { exact: true })).toHaveCount(1);
      expect.soft(await row.innerText()).not.toContain("del mes");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: the next task of a goal with no measure keeps «Siguiente del plan»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Trasteo ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta sin medida ${stamp}`, null);
    const month = `${todayInZone().slice(0, 7)}-01`;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
      values (${person.id}, ${goal}, ${name}, ${month}::date, 1)
    `;

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText("Siguiente del plan", { exact: true })).toHaveCount(1);
      expect.soft(await row.innerText()).not.toContain("del mes");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });

  test(`Hoy at ${width}: a task in minutes split across months keeps «Siguiente del plan · 10 h este mes»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Partida ${letters(stamp)}`;
    const goal = await seedGoal(db, person.id, `Meta partida ${stamp}`, { unit: "minutos", rhythm: 600 });
    await planTask(db, person.id, goal, name, 1800);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = rowOf(page, name);
      await expect(row).toBeVisible();
      await expect.soft(row.getByText(/^Siguiente del/)).toHaveText("Siguiente del plan · 10 h este mes");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}
