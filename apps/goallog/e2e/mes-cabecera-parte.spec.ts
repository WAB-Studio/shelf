import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// RP-76: the first month's share is the month's planned amount wherever it is
// read, «Mes» included. A goal opened today at 10 h a month, with 13 h of
// tasks, plans only its share of the month: «Mes» heads its tasks with that
// share, the same figure the month's page heads them with.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const today = todayInZone();
const month = monthOf(today);
const seg = month.slice(0, 7);
const year = Number(today.slice(0, 4));
const monthIndex = Number(today.slice(5, 7));
const dayOfMonth = Number(today.slice(8, 10));
const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
// RP-76: the rhythm spread over the month's days, summed over the goal's days, rounded down.
const share = Math.floor((600 * (daysInMonth - dayOfMonth + 1)) / daysInMonth);
const say = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
};
const monthName = NAMES[monthIndex - 1];

test("«Mes» heads a mid-month goal's tasks with its share, as the month's page does (RP-76)", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${`Meta cabecera ${stamp}`}, (date_trunc('year', now()) + interval '3 years')::date, 'minutos', 'minutos', 600,
      ${today}::date::timestamp at time zone 'America/Bogota')
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position) values
    (${person.id}, ${goal.id}, ${`Primera ${stamp}`}, 300, true, 0),
    (${person.id}, ${goal.id}, ${`Segunda ${stamp}`}, 480, true, 1)
  `;
  expect(share).toBeLessThan(780);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();

    await page.goto(`/metas/${goal.id}/meses/${seg}`);
    const monthHeader = page.getByText(new RegExp(`^tareas · ${say(share)}$`, "i"));
    await expect(monthHeader).toBeVisible();

    await page.goto("/mes");
    const panel = page.getByRole("heading", { name: `Meta cabecera ${stamp}` }).locator("xpath=../..");
    const acrossHeader = panel.getByText(new RegExp(`^de ${monthName} · ${say(share)}$`, "i"));
    await expect(acrossHeader).toBeVisible();
  } finally {
    await context.close();
  }
});
