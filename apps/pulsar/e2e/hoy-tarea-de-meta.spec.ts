import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";

// 408, `HoyTareaDeMeta` and its two states (RP-19, RP-20,
// RP-50): the field in a goal's group is a task of that goal. Its words are the
// boards', typed here as written, never read back from the catalogue.

type Db = postgres.Sql;

async function seedGoal(db: Db, personId: string, name: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
    values (${personId}, ${name}, '2099-12-31', 'minutos', 'minutos', 600) returning id
  `;
  // It asks something, or Hoy draws no group for the goal (RP-47).
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${goal.id}, 'Tocar', 'daily', 'tap')
  `;
  return goal.id;
}

const field = (page: Page, goal: string) => page.getByLabel(`Una tarea de ${goal}`, { exact: true });

// Under 1024 the day has one task field and the goal is a chip under it
// (HoyUnCampo); from 1024 each goal's group keeps its own. Either way the
// returned locator is the input the name goes into, the goal already chosen.
const PHONE_FIELD = "Escribe una tarea…";
async function fillTask(page: Page, goal: string, task: string, width: number) {
  if (width >= 1024) {
    const input = field(page, goal);
    await input.fill(task);
    return input;
  }
  const input = page.getByPlaceholder(PHONE_FIELD);
  await input.fill(task);
  await page.getByRole("radiogroup", { name: "de qué meta" }).getByRole("radio", { name: goal, exact: true }).click();
  return input;
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test("the goal's field is a task of the goal and says nothing of «suelto» (RP-20)", async ({ person, browser, db }) => {
      const goal = `Inglés B2+ ${Date.now()}`;
      const goalId = await seedGoal(db, person.id, goal);
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/");
        const wide = width >= 1024;
        const input = wide ? field(page, goal) : page.getByPlaceholder(PHONE_FIELD);
        await expect(input).toBeVisible();
        await expect(input).toHaveAttribute("placeholder", wide ? `Una tarea de ${goal}…` : PHONE_FIELD);
        await expect(page.getByLabel(/suelto de/i)).toHaveCount(0);
        await expect(page.getByPlaceholder(/suelto de/i)).toHaveCount(0);
        const form = page.locator("form").filter({ has: input });
        await expect(form).not.toContainText(/suelto/i);
        if (wide) {
          // The goalless field below keeps its own words.
          await expect(page.getByLabel("Algo suelto", { exact: true })).toBeVisible();
        } else {
          // The goal is chosen inside the one field, not asked by a group of its own.
          await expect(page.getByLabel(/^Una tarea de /).locator("visible=true")).toHaveCount(0);
          await input.fill("Algo");
          await expect(page.getByRole("radiogroup", { name: "de qué meta" }).getByRole("radio", { name: goal, exact: true })).toBeVisible();
        }
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${goalId}`;
      }
    });

    test("«sin día» says it went to the plan, links to it, and the plan lists it; Sueltas does not (RP-50)", async ({
      person,
      browser,
      db,
    }) => {
      const goal = `Inglés B2+ ${Date.now()}`;
      const task = `Tarea sin día ${Date.now()}`;
      const goalId = await seedGoal(db, person.id, goal);
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto("/");
        await fillTask(page, goal, task, width);
        await page.getByRole("radio", { name: "sin día" }).click();
        await page.getByRole("button", { name: "Anotar" }).click();

        const status = page.getByRole("status");
        await expect(status).toContainText(width >= 1024 ? `Anotada en el plan de ${goal}.` : `Quedó en el plan de ${goal}.`);
        await expect(status).not.toContainText("sin día");
        const link = status.getByRole("link", { name: "ver el plan", exact: true });
        await expect(link).toHaveAttribute("href", `/metas/${goalId}/plan`);

        const rows = await db<{ in_plan: boolean; day: string | null; goal_id: string }[]>`
          select in_plan, day, goal_id from goals.one_offs where user_id = ${person.id} and name = ${task}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].in_plan).toBe(true);
        expect(rows[0].day).toBeNull();
        expect(rows[0].goal_id).toBe(goalId);

        await link.click();
        await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/plan$`));
        await expect(page.getByText(task)).toBeVisible();

        await page.goto("/sueltas");
        await expect(page.getByText(task)).toHaveCount(0);
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${goalId}`;
      }
    });
  });
}

test("«hoy» draws the task in the goal's group and shows no plan line", async ({ person, browser, db }) => {
  const goal = `Inglés B2+ ${Date.now()}`;
  const task = `Tarea de hoy ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, goal);
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const input = await fillTask(page, goal, task, 390);
    await input.press("Enter");
    await expect(page.getByText(task)).toBeVisible();
    // The status is the board's «Anotada en {goal}.», never a plan line.
    await expect(page.getByRole("status")).toHaveText(`Anotada en ${goal}.`);
    await expect(page.getByText("Anotada en el plan")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "ver el plan", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("«Anotar» is disabled while the write is pending, and one row lands", async ({ person, browser, db }) => {
  const goal = `Inglés B2+ ${Date.now()}`;
  const task = `Tarea pendiente ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, goal);
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.continue();
        return;
      }
      calls += 1;
      if (calls === 1) await held;
      await route.continue();
    });

    await fillTask(page, goal, task, 390);
    await page.getByRole("radio", { name: "sin día" }).click();
    const submit = page.getByRole("button", { name: "Anotar" });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect.poll(() => calls).toBe(1);
    await submit.click({ force: true });
    release();

    await expect(page.getByRole("status")).toBeVisible();
    const rows = await db`select 1 from goals.one_offs where user_id = ${person.id} and name = ${task}`;
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("an empty name in the goal's field is refused with the task's words, not «suelto» (RP-50)", async ({
  person,
  browser,
  db,
}) => {
  const goal = `Inglés B2+ ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, goal);
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const input = page.getByPlaceholder(PHONE_FIELD);
    await input.fill("   ");
    await input.press("Enter");
    await expect(page.getByText("Escribe el nombre de la tarea.")).toBeVisible();
    await expect(page.getByText("Escribe qué hay que hacer.")).toHaveCount(0);
    await expect(page.getByText("Escribe qué es lo suelto.")).toHaveCount(0);
    await expect(page.getByText(/suelto/i).filter({ hasText: "Escribe" })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("the goalless field is unchanged: «sin día» counts the waiting list, empty says «suelto»", async ({ page, db, personId }) => {
  const task = `Suelta sin día ${Date.now()}`;
  try {
    // From 1024 the goalless field keeps its words; under it the one field is HoyUnCampo's.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const input = page.getByLabel("Algo suelto", { exact: true }).locator("visible=true").last();
    await input.fill(task);
    await page.getByRole("radio", { name: "sin día" }).click();
    await page.getByRole("button", { name: "Anotar" }).click();
    await expect(page.getByRole("status")).toContainText(/^Anotada sin día: espera en «\d+ sin día»\.$/);
    await expect(page.getByRole("link", { name: "ver el plan", exact: true })).toHaveCount(0);

    await input.fill("   ");
    await input.press("Enter");
    await expect(page.getByText("Escribe qué es lo suelto.")).toBeVisible();
    await expect(page.getByText("Escribe qué hay que hacer.")).toHaveCount(0);
  } finally {
    await db`delete from goals.one_offs where user_id = ${personId} and name = ${task}`;
  }
});

test("at 360 a 40-letter goal fits its chip and the plan line", async ({ person, browser, db }) => {
  const goal = "Inglés laboral de la oficina y del viaje".slice(0, 40).padEnd(40, "x");
  const task = `Tarea ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, goal);
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 360, height: 740 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const input = page.getByPlaceholder(PHONE_FIELD);
    await expect(input).toBeVisible();
    await fillTask(page, goal, task, 360);
    await page.getByRole("radio", { name: "sin día" }).click();
    await page.getByRole("button", { name: "Anotar" }).click();
    await expect(page.getByRole("status")).toContainText(`Quedó en el plan de ${goal}.`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
