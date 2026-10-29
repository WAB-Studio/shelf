import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// What Hoy's rows and goal lines say (`HoyEscritorio.dc.html`): the
// count under the date, each row's cadence, the hour a done one was written,
// and the goal's place among its phases.

const WEEKDAYS_PLURAL = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("Hoy says how many it asks, each row's cadence, the hour of a done one and «fase 2 de 3»", async ({
  person,
  browser,
  db,
}) => {
  // A person of this spec's own: the count spans every goal of the identity.
  const context = await browser.newContext({ storageState: person.sessionFile });
  const today = todayInZone();
  const isoWeekday = ((civilDateToDate(today).getUTCDay() + 6) % 7) + 1;

  const [phased] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, 'Inglés pide', ${plusDays(90)}) returning id
  `;
  const [single] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, 'Gimnasio pide', ${plusDays(90)}) returning id
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values
      (${person.id}, ${phased.id}, 'primera fase', ${plusDays(-30)}, ${plusDays(-11)}),
      (${person.id}, ${phased.id}, 'desbloquear la boca', ${plusDays(-10)}, ${plusDays(10)}),
      (${person.id}, ${phased.id}, 'tercera fase', ${plusDays(11)}, ${plusDays(40)})
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${single.id}, 'fase única', ${plusDays(-10)}, ${plusDays(10)})
  `;
  const [anki] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${person.id}, ${phased.id}, 'Anki', 'daily', 'quantity', 10, 'minutos') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction)
    values (${person.id}, ${phased.id}, 'Listening difícil', 'weekdays', ${[isoWeekday]}, 'tap')
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction)
    values (${person.id}, ${single.id}, 'Empuje', 'times_per_week', 3, 'tap')
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity, written_at)
    values (${person.id}, ${anki.id}, ${phased.id}, ${today}, 10, ${`${today}T07:40:00-05:00`})
  `;

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Anki", { exact: true })).toBeVisible();

    await expect(page.getByText("hechos 1 de 3", { exact: true })).toBeVisible();
    await expect(page.getByText("fase 2 de 3 · desbloquear la boca", { exact: true })).toBeVisible();
    await expect(page.getByText("fase única", { exact: true })).toBeVisible();
    await expect(page.getByText(`solo los ${WEEKDAYS_PLURAL[isoWeekday - 1]}`, { exact: true })).toBeVisible();
    await expect(page.getByText("0 de 3 esta semana", { exact: true })).toBeVisible();
    await expect(page.getByText("todos los días · 10 min · 07:40 · lo dijiste tú", { exact: true })).toBeVisible();

    // A past day with no goal open counts nothing.
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
    await expect(page.getByText("hechos", { exact: false })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id in (${phased.id}, ${single.id}) and user_id = ${person.id}`;
  }
});
