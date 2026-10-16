import { test, expect } from "./fixtures";
import { civilDateToDate, todayInZone } from "@/lib/zone";

// RP-12: a quantity commitment's line on its goal names its target.

function plusDays(n: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

test("a quantity commitment reads its target on the goal: «15 min», «20 páginas»", async ({ person, browser, db }) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  let goalId: string | undefined;
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon)
      values (${person.id}, 'Meta objetivo', ${plusDays(90)}) returning id
    `;
    goalId = goal.id;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
      values (${person.id}, ${goal.id}, 'Escuchar', 'daily', 'quantity', 15, 'minutos'),
             (${person.id}, ${goal.id}, 'Leer', 'daily', 'quantity', 20, 'páginas')
    `;
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}`);
    await expect(page.getByText("15 min", { exact: true })).toBeVisible();
    await expect(page.getByText("20 páginas", { exact: true })).toBeVisible();
    // The unit's text node follows a space character, never glued to the figure.
    const before = await page
      .getByText("páginas", { exact: true })
      .evaluate((el) => (el.previousSibling?.textContent ?? "").slice(-1));
    expect(before).toMatch(/^\s$/);
    await expect(page.getByText("minutos", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
    if (goalId) await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
