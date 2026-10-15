import { expect, test } from "./fixtures";
import { monthsAhead } from "./meta-arbol-seed";
import { seedOpenGoal, visit } from "./metas-sin-final-seed";

// RP-73, MetaSinTareas: only a goal that measures nothing, is inside its span and holds no task this month
// has "nothing to say of it" and keeps «Ver por mes» as the way to the months that do. A goal with no
// current month at all (it holds goals, or its span is over) has no month to open: the screen draws
// neither the month section nor the link, whatever its tasks.

test.use({ actionTimeout: 6000 });

test("360: a goal with no measure that holds goals, or whose span is over, draws no «Ver por mes» and no month section", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: `noMonthBlock` losing `bareMonth &&`, which offers «Ver por mes» on a goal that has no month to open.
  const general = await seedOpenGoal(db, person, { name: "Cuidado general" });
  await seedOpenGoal(db, person, { name: "Cuidado hija", parent: general });
  const over = await seedOpenGoal(db, person, {
    name: "Cuidado cerrado",
    created: new Date(Date.now() - 100 * 86_400_000),
    horizon: monthsAhead(-2),
  });
  try {
    for (const [goal, name] of [
      [general, "Cuidado general"],
      [over, "Cuidado cerrado"],
    ]) {
      const { page, context } = await visit(browser, baseURL, person, `/metas/${goal}`, 360);
      try {
        await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
        await expect(page.getByRole("link", { name: "Ver por mes", exact: true })).toHaveCount(0);
        await expect(page.getByText(/0 tareas/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
