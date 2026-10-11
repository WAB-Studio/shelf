import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// 829 · `UnidadUnaVez.dc.html`: the goal page's month block says its unit once,
// after the last figure of a «de» line, and keeps it on a figure with no «de».

type Db = import("postgres").Sql;

const today = todayInZone();
const thisMonth = monthOf(today);
const late = Number(today.slice(8, 10)) >= 20;
const horizon = (() => {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + 90);
  return dateToCivilDate(date);
})();

async function seed(db: Db, personId: string, unit: string, budget: number | null, reached: number) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Meta unidad ${unit} ${Date.now()}`}, ${horizon}::date, ${unit}, ${unit}, now() - interval '40 days')
    returning id`;
  if (budget !== null) {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${personId}, ${goal.id}, ${thisMonth}::date, ${budget})`;
  }
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${goal.id}, ${`Sesión ${Date.now()}`}, 'daily', 'quantity', 10, ${unit}, now() - interval '40 days')
    returning id`;
  await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${personId}, ${goal.id}, ${commitment.id}, ${today}::date, ${reached})`;
  return goal.id;
}

async function monthText(page: import("@playwright/test").Page, goalId: string, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/metas/${goalId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return ((await page.locator("main").first().textContent()) ?? "").replace(/\s+/g, " ");
}

for (const width of [360, 1280]) {
  test(`${width}: a words unit reads «30 de 60 búsquedas» in the month block (829)`, async ({ person, browser, baseURL, db }) => {
    const goalId = await seed(db, person.id, "búsquedas", 60, 30);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const text = await monthText(await context.newPage(), goalId, width);
      // From the 20th, under 60 %, the pace line holds the same figures.
      expect(text).toMatch(late ? /30 de 60 búsquedas, bajo el 60 %/ : /30 de 60 búsquedas/);
      expect(text).not.toMatch(/30 búsquedas de/);
    } finally {
      await context.close();
    }
  });
}

test("a km goal with no amount keeps its unit: «45 km sin monto planeado» and no «de» (829)", async ({ person, browser, baseURL, db }) => {
  const goalId = await seed(db, person.id, "km", null, 45);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const text = await monthText(await context.newPage(), goalId, 360);
    expect(text).toMatch(/45 km sin monto planeado/);
    expect(text).not.toMatch(/45 de/);
  } finally {
    await context.close();
  }
});
