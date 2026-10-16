import { test, expect } from "./fixtures";
import { civilDateInZone } from "@/lib/zone";
import { dayFromToday } from "./reloj";
import { serverDays } from "./server-day";

// «Retirarlo» takes its day from the clock every other write reads: under a pinned `PULSAR_CLOCK` the stored
// `retired_at` falls on the server's today, never the database's real now(). Meaningful only when the server is pinned
// to a day other than the real one; unpinned, the two agree and the spec proves nothing, so it says so and skips.

test("retiring a commitment stamps the server's day, not the database's now()", async ({ person, browser, db, baseURL }) => {
  const { today } = await serverDays(browser, baseURL, person);
  test.skip(today === civilDateInZone(new Date()), "server clock is not pinned away from the real day");

  const context = await browser.newContext({ storageState: person.sessionFile });
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Reloj de retiro', ${dayFromToday(90)}, now() - interval '20 days')
    returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, 'Se retira', 'daily', 'tap', now() - interval '20 days')
    returning id
  `;
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}`);
    await page.locator("button", { hasText: "Se retira" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Retirarlo" }).click();
    await expect(sheet).toBeHidden();

    await expect
      .poll(async () => {
        const [row] = await db<{ day: string | null }[]>`
          select (retired_at at time zone 'America/Bogota')::date::text as day
          from goals.commitments where id = ${commitment.id}
        `;
        return row.day;
      })
      .toBe(today);
  } finally {
    await db`delete from goals.commitments where id = ${commitment.id}`;
    await db`delete from goals.goals where id = ${goal.id}`;
    await context.close();
  }
});
