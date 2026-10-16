import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

// RP-132: the month line of a goal says «último día» when no day is left, never
// «faltan 0 días». It follows the day the app reads, so run it with
// `PULSAR_CLOCK` on the month's last day (on any other day the plural line holds).

const today = todayInZone();
const monthStart = `${today.slice(0, 7)}-01`;
const monthEnd = dateToCivilDate(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)));
const daysLeft = Math.round((Date.parse(monthEnd) - Date.parse(today)) / 86_400_000);

function plusDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("the month line reads «último día» on the last day and «faltan N días» before it (RP-132)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  try {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta último día ${Date.now()}`}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '40 days')
      returning id
    `;
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${monthStart}::date, 100)
    `;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${`Sesión ${Date.now()}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
      returning id
    `;
    // On pace (100 %), so the pace line never replaces the month line late in the month.
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${monthStart}::date, 100)
  `;

    await page.goto(`/metas/${goal.id}`);
    const line = page.getByText(/^llevas \d+ %/).locator("visible=true");
    if (daysLeft === 0) {
      await expect(line).toHaveText("llevas 100 % · último día");
      await expect(page.getByText(/faltan 0/)).toHaveCount(0);
    } else {
      await expect(line).toHaveText(`llevas 100 % · faltan ${daysLeft === 1 ? "1 día" : `${daysLeft} días`}`);
    }
  } finally {
    await context.close();
  }
});
