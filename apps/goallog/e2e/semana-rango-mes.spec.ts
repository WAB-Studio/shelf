import day from "../messages/es/day.json";
import week from "../messages/es/week.json";
import { test, expect } from "./fixtures";

// RP-16 on Semana: a week inside one month names it, a week across two keeps
// the short form (`PalabrasDelPlan`). Goals opened on each Monday so
// `?semana=` reaches them whatever today is.

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key]);

const goalOpenedOn = (monday: string) => `${monday}T17:00:00Z`;

test("a week inside one month reads «Del 5 al 11 de octubre»; one across two keeps «Del 28 sep al 4 oct» (RP-16)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const ids: string[] = [];
  for (const monday of ["2026-09-28", "2026-10-05"]) {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Meta rango ${monday}`}, '2099-12-31', ${goalOpenedOn(monday)}) returning id
    `;
    ids.push(goal.id);
  }
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 900 });

    await page.goto("/semana?semana=2026-10-05");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      fill(week.rangeWithMonth, { start: "5", end: "11", month: day.monthLong[9] }),
    );

    await page.goto("/semana?semana=2026-09-28");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      fill(week.range, { start: `28 ${week.monthShort[8]}`, end: `4 ${week.monthShort[9]}` }),
    );
  } finally {
    await context.close();
    await db`delete from goals.goals where id in ${db(ids)}`;
  }
});
