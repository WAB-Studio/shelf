import { test, expect } from "./fixtures";
import { monthWord, thisMonth } from "./meta-arbol-seed";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";

// RP-73, `noMonthBlock`: a goal that measures nothing, is inside its span and holds no task of its own this
// month draws no month block, and «Ver por mes» is the way to the months that do. One task this month brings
// the block back.

test.use({ actionTimeout: 6000 });

test("360: a goal with no task of its own this month shows «Ver por mes» and no bare month block", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: `noMonthBlock` always false, which draws «0 tareas · 0 hechas» under the month's name.
  const goal = await seedOpenGoal(db, person, { name: "Cuidado sin mes" });
  const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Cuidado sin mes" })).toBeVisible();
    const months = page.getByRole("link", { name: "Ver por mes", exact: true });
    await expect(months).toBeVisible();
    await expect(months).toHaveAttribute("href", `/metas/${goal}/meses`);
    await expect(page.getByText(monthWord, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/\d+ tareas? · \d+ hechas?/)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("360: with one task of its own this month the block is drawn, with the link inside it", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: `noMonthBlock` always true, which hides the block of a goal that does hold a task this month.
  const goal = await seedOpenGoal(db, person, { name: "Cuidado con mes" });
  await db`
    insert into goals.one_offs (user_id, goal_id, name, position, in_plan, planned_month)
    values (${person.id}, ${goal}, 'Pedir cita', 1, true, ${thisMonth}::date)`;
  const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
  try {
    await expect(page.getByText("1 tarea · 0 hechas", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute("href", `/metas/${goal}/meses`);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
