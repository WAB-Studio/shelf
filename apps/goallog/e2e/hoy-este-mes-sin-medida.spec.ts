import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `HoyTelefonoSinPedido.dc.html`, `HoyTareaMesSubtarea.dc.html`: every goal
// with tasks this month has its «este mes» line on Hoy, measured or not; the
// desktop side card of a goal with no month plan is titled by the goal; a unit
// word agrees with its number.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

const today = todayInZone();
const monthStart = `${today.slice(0, 7)}-01`;

async function seedGoal(db: postgres.Sql, personId: string, name: string, unit: string | null) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${plusDays(90)}, ${unit}, ${unit}, now() - interval '40 days')
    returning id
  `;
  return goal.id;
}

test("a goal with no measure shows «N de M tareas» and its next task in «este mes» at 360; a measured goal with no plan shows its reached figure and tasks", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const moving = `Mudanza ${stamp}`;
  const running = `Correr ${stamp}`;
  const movingId = await seedGoal(db, person.id, moving, null);
  const runningId = await seedGoal(db, person.id, running, "kilómetros");
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
    values (${person.id}, ${movingId}, ${`Hecha ${stamp}`}, ${monthStart}::date, 1) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${movingId}, ${done.id}, ${today}::date)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
    values (${person.id}, ${movingId}, ${`Siguiente ${stamp}`}, ${monthStart}::date, 2),
           (${person.id}, ${movingId}, ${`Última ${stamp}`}, ${monthStart}::date, 3)
  `;
  const [ran] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, position)
    values (${person.id}, ${runningId}, ${`Ruta ${stamp}`}, ${monthStart}::date, 5, 1) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${runningId}, ${ran.id}, ${today}::date)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
    values (${person.id}, ${runningId}, ${`Pendiente ${stamp}`}, ${monthStart}::date, 2)
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
    const movingLine = block.locator("div").filter({ hasText: moving }).filter({ hasText: "de 3 tareas" }).last();
    await expect(movingLine).toContainText(/1\s*de 3 tareas/);
    await expect(movingLine.getByRole("button", { name: `Marcar hecha: Siguiente ${stamp}` })).toBeVisible();
    const runningLine = block.locator("div").filter({ hasText: running }).filter({ hasText: "de 2 tareas" }).last();
    // «Ruta» still holds its stored 5; in kilómetros a task's figure adds nothing (RP-65).
    await expect(runningLine).toContainText(new RegExp(`${running}\\s*0\\s*kilómetros\\s*· 1 de 2 tareas`));
    await expect(runningLine.getByRole("button", { name: `Marcar hecha: Pendiente ${stamp}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // At 1280 the same goal has its card: the goal's name, its tasks and its next task.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const card = page
      .locator("div")
      .filter({ has: page.getByText(moving, { exact: true }).locator("visible=true") })
      .filter({ hasText: "de 3 tareas" })
      .last();
    await expect(card).toContainText(/1\s*de 3 tareas/);
    await expect(card.getByRole("button", { name: `Marcar hecha: Siguiente ${stamp}` }).locator("visible=true")).toBeVisible();
    await expect(
      page
        .locator("[data-part='section-label']", { hasText: moving })
        .locator("visible=true")
        .locator("xpath=following-sibling::*[1]")
        .filter({ hasText: /^este mes$/i }),
    ).toHaveCount(1);
  } finally {
    await context.close();
    await db`delete from goals.goals where id in (${movingId}, ${runningId}) and user_id = ${person.id}`;
  }
});

test("at 1280 the side card of a goal with no month plan is titled by the goal's name, never by its unit", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const name = `Meta sin plan ${stamp}`;
  const goalId = await seedGoal(db, person.id, name, "kilómetros");
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    // The week's figure stands at the end of the goal's head, which the goal's name titles.
    const card = page.locator("[data-part='group-head']").filter({ hasText: name }).filter({ hasText: "esta semana" });
    await expect(card.getByRole("heading", { level: 2 })).toHaveText(name);
    await expect(page.locator("[data-part='section-label']").filter({ hasText: /^kilómetros$/i })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("a past day with one of a counted unit reads it in the singular", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta lecciones ${stamp}`, null);
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, ${`Estudiar ${stamp}`}, 'daily', 'quantity', 1, 'lecciones', now() - interval '40 days')
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.getByText(/1 lección\b/).locator("visible=true").first()).toBeVisible();
    await expect(page.getByText(/1 lecciones/).locator("visible=true")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("one of a counted unit or one task reads in the singular on Hoy: «1 kilómetro», «de 1 tarea»", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const running = `Rodar uno ${stamp}`;
  const moving = `Trasteo uno ${stamp}`;
  const runningId = await seedGoal(db, person.id, running, "kilómetros");
  const movingId = await seedGoal(db, person.id, moving, null);
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${runningId}, ${`Trotar ${stamp}`}, 'daily', 'quantity', 5, 'kilómetros', now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${person.id}, ${commitment.id}, ${runningId}, ${today}::date, 1)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
    values (${person.id}, ${movingId}, ${`Única ${stamp}`}, ${monthStart}::date, 1)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
    const movingLine = block.locator("div").filter({ hasText: moving }).filter({ hasText: "de 1 tarea" }).last();
    await expect(movingLine).toContainText(/0\s*de 1 tarea(?!s)/);
    await expect(block).not.toContainText("de 1 tareas");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const card = page.locator("[data-part='group-head']").filter({ hasText: running }).filter({ hasText: "esta semana" });
    await expect(card).toContainText(/1\s*kilómetro(?!s)/);
    await expect(card).not.toContainText("kilómetros");
  } finally {
    await context.close();
    await db`delete from goals.goals where id in (${runningId}, ${movingId}) and user_id = ${person.id}`;
  }
});
