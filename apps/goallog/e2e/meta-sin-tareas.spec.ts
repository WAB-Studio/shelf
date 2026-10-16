import { test, expect } from "./fixtures";
import { monthWord, monthsAhead, thisMonth } from "./meta-arbol-seed";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";

import type { Db } from "./meta-arbol-seed";
import type { Person } from "./fixtures";

// Module 994, board MetaSinTareas (RP-73, approved 2026-10-14): a goal that measures nothing and holds no task this month draws no month
// section — no «0 tareas · 0 hechas», no «OCTUBRE» — and «Ver por mes» stays visible, as on an archived goal without tasks.
// With a task this month the section is as before («1 tarea · 0 hechas»). A task of another month does not count as this month's.

test.use({ actionTimeout: 6000 });

async function seedCuidado(db: Db, person: Person) {
  const goal = await seedOpenGoal(db, person, { name: "Cuidado personal", created: new Date(Date.now() - 20 * 86_400_000) });
  for (const name of ["Estirar", "Tomar agua"]) {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${goal}, ${name}, 'daily', 'tap', now() - interval '20 days')`;
  }
  return goal;
}

async function seedTask(db: Db, person: Person, goal: string, month: string) {
  await db`
    insert into goals.one_offs (user_id, goal_id, name, position, in_plan, planned_month)
    values (${person.id}, ${goal}, 'Pedir cita', 1, true, ${month}::date)`;
}

for (const width of [360, 1280]) {
  test(`${width}: a goal that measures nothing and has no task this month says no «0 tareas» and no month section, and keeps «Ver por mes»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: drawing `bareBlock` with a count of 0 (the section «OCTUBRE · 0 tareas · 0 hechas» of c67dc44e).
    const goal = await seedCuidado(db, person);
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, width);
    try {
      await expect(page.getByRole("heading", { level: 1, name: "Cuidado personal" })).toBeVisible();
      await expect(page.getByText("esta meta no mide nada", { exact: true })).toBeVisible();
      await expect(page.getByText("Ponerle medida", { exact: true }).locator("visible=true").first()).toBeVisible();
      await expect(page.getByText("Estirar").first()).toBeVisible();
      await expect(page.getByText("Tomar agua").first()).toBeVisible();

      await expect(page.getByText(/0 tareas/)).toHaveCount(0);
      await expect(page.getByText(/0 hechas/)).toHaveCount(0);
      await expect(page.getByText(monthWord, { exact: true })).toHaveCount(0);
      const months = page.getByRole("link", { name: "Ver por mes", exact: true });
      await expect(months).toBeVisible();
      await expect(months).toHaveAttribute("href", `/metas/${goal}/meses`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

test("360: a task planned for another month is not this month's: still no section and no «0 tareas»", async ({ person, browser, baseURL, db }) => {
  // Kills: the section drawn whenever the goal has any task, not this month's.
  const goal = await seedCuidado(db, person);
  await seedTask(db, person, goal, monthsAhead(1));
  const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
  try {
    await expect(page.getByText("esta meta no mide nada", { exact: true })).toBeVisible();
    await expect(page.getByText(/0 tareas/)).toHaveCount(0);
    await expect(page.getByText(monthWord, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute("href", `/metas/${goal}/meses`);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

for (const width of [360, 1280]) {
  test(`${width}: with one task this month the section is as before: the month and «1 tarea · 0 hechas»`, async ({ person, browser, baseURL, db }) => {
    // Kills: the section silenced for a goal that does hold a task this month.
    const goal = await seedCuidado(db, person);
    await seedTask(db, person, goal, thisMonth);
    const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, width);
    try {
      await expect(page.getByText(monthWord, { exact: true }).locator("visible=true")).toHaveCount(1);
      await expect(page.getByText("1 tarea · 0 hechas", { exact: true }).locator("visible=true")).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveAttribute("href", `/metas/${goal}/meses`);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}
