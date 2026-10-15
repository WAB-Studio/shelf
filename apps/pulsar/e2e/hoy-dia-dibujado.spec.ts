import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// A tap on Hoy writes the day the screen was drawn for, never the moment of the tap. The server's clock cannot move
// mid-spec, so the stale tab is the tap's own request rewritten to the day before: what a tab drawn on D sends once the
// server is on D+1. Kills: dropping `day` from the Hoy tap (the fact lands on the server's today); trusting any day on Hoy.

function dayBefore(day: string): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateToCivilDate(date);
}

test("a tap on Hoy sends the drawn day, and the server writes that day, not its own today", async ({ page, db, personId }) => {
  const stamp = Date.now();
  const today = todayInZone();
  const drawn = dayBefore(today);
  const name = `Tocar dibujado ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, created_at) values (${personId}, ${`Meta dibujada ${stamp}`}, now() - interval '5 days')
    returning id`;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${name}, 'daily', 'tap', now() - interval '3 days')
    returning id`;
  try {
    await page.goto("/");
    const sent: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() === "POST" && body?.includes(commitment.id)) {
        sent.push(body);
        await route.continue({ postData: body.replace(`"day":"${today}"`, `"day":"${drawn}"`) });
      } else {
        await route.continue();
      }
    });
    await page.locator("button", { hasText: name }).click();
    await expect.poll(async () => (await db`select 1 from goals.facts where commitment_id = ${commitment.id}`).length).toBe(1);
    expect(sent[0], "the tap names the day the screen was drawn for").toContain(`"day":"${today}"`);
    const facts = await db<{ day: string }[]>`select day::text as day from goals.facts where commitment_id = ${commitment.id}`;
    expect(facts.map((fact) => fact.day)).toEqual([drawn]);
  } finally {
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
  }
});

test("a Hoy tap more than a day behind the server's today is refused, not written", async ({ page, db, personId }) => {
  const stamp = Date.now();
  const today = todayInZone();
  const old = dayBefore(dayBefore(today));
  const name = `Tocar vieja ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, created_at) values (${personId}, ${`Meta vieja ${stamp}`}, now() - interval '5 days')
    returning id`;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${name}, 'daily', 'tap', now() - interval '3 days')
    returning id`;
  try {
    await page.goto("/");
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() === "POST" && body?.includes(commitment.id)) {
        await route.continue({ postData: body.replace(`"day":"${today}"`, `"day":"${old}"`) });
      } else {
        await route.continue();
      }
    });
    await page.locator("button", { hasText: name }).click();
    await expect(page.getByText("La pantalla quedó de otro día. Recárgala.")).toBeVisible();
    expect(await db`select 1 from goals.facts where commitment_id = ${commitment.id}`).toHaveLength(0);
  } finally {
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
  }
});
