import { test, expect } from "./fixtures";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `RoadmapTramoMedio` (RP-54): a task split over months reads its
// part under its name on each month's page and in «Mes». Calendar-bound: the
// goal's rhythm is 10 h, so a 25 h task fills this month, the next and half of
// the one after.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const label = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];

const first = monthOf(todayInZone());
const middle = nextMonth(first);
const last = nextMonth(middle);
const horizon = nextMonth(nextMonth(last));
const seg = (month: string) => month.slice(0, 7);
// A month of another year names its year, as the row does.
const named = (month: string) =>
  month.slice(0, 4) === first.slice(0, 4) ? label(month) : `${label(month)} de ${month.slice(0, 4)}`;

type Db = import("postgres").Sql;

async function seed(db: Db, personId: string, stamp: number) {
  // Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta partes ${stamp}`}, ${horizon}::date, 'minutos', 'minutos', 600, date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota')
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan)
    values (${personId}, ${goal.id}, ${`Larga ${stamp}`}, 1500, true)
  `;
  return goal.id;
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    async function open(browser: import("@playwright/test").Browser, baseURL: string, sessionFile: string, path: string) {
      const context = await browser.newContext({ storageState: sessionFile, baseURL, viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(path);
      return { context, page };
    }

    const cases = [
      { name: "first month", month: first, line: () => `Empieza aquí con 10 h y sigue en ${named(middle)}.`, trailing: "10 de 25 h" },
      { name: "middle month", month: middle, line: () => `Viene de ${named(first)} y sigue en ${named(last)}.`, trailing: "10 de 25 h" },
      { name: "last month", month: last, line: () => `Viene de ${named(middle)}.`, trailing: "5 de 25 h" },
    ];
    for (const { name, month, line, trailing } of cases) {
      test(`the ${name}'s page reads the part's sentence under the name (RP-54)`, async ({ person, browser, baseURL, db }) => {
        const stamp = Date.now();
        const goalId = await seed(db, person.id, stamp);
        const { context, page } = await open(browser, baseURL!, person.sessionFile, `/metas/${goalId}/meses/${seg(month)}`);
        try {
          await expect(page.getByRole("button", { name: new RegExp(`^Larga ${stamp}`) })).toBeVisible();
          await expect(page.getByText(line(), { exact: true })).toBeVisible();
          await expect(page.getByText(trailing, { exact: true }).and(page.locator(":visible"))).toBeVisible();
        } finally {
          await context.close();
        }
      });
    }

    test("«Mes» reads the first month's part for the goal (RP-54)", async ({ person, browser, baseURL, db }) => {
      const stamp = Date.now();
      await seed(db, person.id, stamp);
      const { context, page } = await open(browser, baseURL!, person.sessionFile, "/mes");
      try {
        const panel = page.getByRole("heading", { name: `Meta partes ${stamp}` }).locator("xpath=../..");
        await expect(panel.getByText(`Empieza aquí con 10 h y sigue en ${named(middle)}.`, { exact: true })).toBeVisible();
        await expect(panel.getByText("10 de 25 h", { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
}
