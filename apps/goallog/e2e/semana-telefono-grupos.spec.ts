import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-16, RP-44 on Semana's phone: a goal with no row that week draws no header;
// the table and the fold show the same groups.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const thisMonday = shift(today, -((civilDateToDate(today).getUTCDay() + 6) % 7));
const lastMonday = shift(thisMonday, -7);

test("at 390 a goal with no row that week draws no header; the one with rows does", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const created = new Date(`${shift(today, -40)}T17:00:00Z`);
  const [full] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Inglés grupos', ${shift(today, 60)}, ${created}) returning id
  `;
  const [empty] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Mudanza', ${shift(today, 60)}, ${created}) returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${full.id}, 'Leer', 'daily', 'tap', ${created})
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/semana?semana=${lastMonday}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const headings = page.getByRole("heading", { level: 2 }).filter({ visible: true });
    await expect(headings.filter({ hasText: "Inglés grupos" })).toHaveCount(1);
    await expect(headings.filter({ hasText: "Mudanza" })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id in (${full.id}, ${empty.id})`;
  }
});
