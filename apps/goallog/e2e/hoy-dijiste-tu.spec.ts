import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// What a row says about who wrote it (`HoyEscritorio.dc.html`):
// a marked one says «lo dijiste tú» after its hour, an unmarked quantity one
// says only its target (never «pide el número», `HoyDia`), one logged under its target says
// what it holds, an unmarked tap row and a quiet met row say neither.
// Paths by day: the flexible row is quiet every day but a Monday the 1st, when
// nothing earlier in its week or month met it and it reads its own progress.

test("Hoy says «lo dijiste tú» on a marked row and nothing more on an unmarked quantity row", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const today = todayInZone();
  const ahead = civilDateToDate(today);
  ahead.setUTCDate(ahead.getUTCDate() + 90);
  const horizon = dateToCivilDate(ahead);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Dijiste', ${horizon}, now() - interval '20 days')
    returning id
  `;
  const insertCommitment = async (name: string, satisfaction: string, target: number | null, unit: string | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${name}, 'daily', ${satisfaction}, ${target}, ${unit}, now() - interval '20 days')
      returning id
    `;
    return row.id;
  };
  const marked = await insertCommitment("Marcada", "tap", null, null);
  const counted = await insertCommitment("Contada", "quantity", 10, "minutos");
  await insertCommitment("Sin marcar", "tap", null, null);
  await insertCommitment("Sin número", "quantity", 3, "min");
  const partial = await insertCommitment("Parcial", "quantity", 3, "min");
  // Met earlier in its week, or its month on a Monday. Monday the 1st has
  // neither: the fact seeded yesterday falls in the period before, so the row
  // is still owed.
  const weekday = (civilDateToDate(today).getUTCDay() + 6) % 7;
  const monthDay = Number(today.slice(8));
  const period = weekday > 0 ? "week" : "month";
  const met = weekday > 0 || monthDay > 1;
  const [quietRow] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
    values (${person.id}, ${goal.id}, 'Cumplida', ${period === "week" ? "times_per_week" : "times_per_month"}, 1, 'tap',
            now() - interval '20 days')
    returning id
  `;
  const before = civilDateToDate(today);
  before.setUTCDate(before.getUTCDate() - 1);
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, written_at)
    values (${person.id}, ${quietRow.id}, ${goal.id}, ${dateToCivilDate(before)}, now())
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
    values (${person.id}, ${partial}, ${goal.id}, ${today}, 1, ${`${today}T09:22:00-05:00`})
  `;
  for (const [id, quantity] of [[marked, null], [counted, 10]] as const) {
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
      values (${person.id}, ${id}, ${goal.id}, ${today}, ${quantity}, ${`${today}T07:40:00-05:00`})
    `;
  }

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Marcada", { exact: true })).toBeVisible();

    await expect(page.getByText("todos los días · 07:40 · lo dijiste tú", { exact: true })).toBeVisible();
    await expect(page.getByText("todos los días · 10 min · 07:40 · lo dijiste tú", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sin número/ }).getByText("3 min", { exact: true })).toBeVisible();
    // Logged under its target: what it holds, never a second ask.
    await expect(page.getByText("todos los días · 1 de 3 min · 09:22 · lo dijiste tú", { exact: true })).toBeVisible();
    // No row says «pide el número» any more (`HoyDia`).
    await expect(page.getByText("pide el número")).toHaveCount(0);
    await expect(page.getByText("lo dijiste tú")).toHaveCount(3);
    // A flexible row met earlier in its period stays quiet.
    const metPhrase = period === "week" ? "cumplida esta semana · 1 de 1" : "cumplida este mes · 1 de 1";
    await expect(page.getByText(metPhrase, { exact: true })).toHaveCount(met ? 1 : 0);
    await expect(page.getByText(/cumplida (esta semana|este mes)/)).toHaveCount(met ? 1 : 0);
    // Owed, it is a row asking for a tap with its own progress.
    const quiet = page.getByRole("button", { name: /^Cumplida/ });
    await expect(quiet).toContainText(met ? metPhrase : "0 de 1 este mes");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
