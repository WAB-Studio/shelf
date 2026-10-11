import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, visit, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

// Semana says when a goal ended (`SemanaMetaTerminada.dc.html`): «terminó el
// <día> · ver» under its name, never «ayer». Each test seeds a person of its
// own and horizons relative to today. A goal whose horizon is today ended
// yesterday: on a Monday that is last week and the line is absent (RP-27), so
// every test that needs the line skips on a Monday and says so in the report.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
// 0 is Monday.
const todayIndex = (civilDateToDate(today).getUTCDay() + 6) % 7;
// Yesterday belongs to this week only after a Monday.
const isMonday = todayIndex === 0;
const MONDAY_ENDED = "el lunes la línea no existe (la meta terminó la semana pasada); lo cubre la corrida de otro día";
// Times an ended goal's name is visible on Semana when it is drawn.
const NAME_DRAWS = 1;

// ICU's Spanish, never the catalogue's list the screen reads.
function dayWords(day: string): string {
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(civilDateToDate(day));
  return `${weekday} ${Number(day.slice(8, 10))}`;
}

async function seedGoal(db: postgres.Sql, personId: string, name: string, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizon}, ${new Date(Date.now() - 60 * 86_400_000)}) returning id
  `;
  // The table face draws a goal only once it holds a row.
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, 'Compromiso', 'daily', 'tap', ${new Date(Date.now() - 60 * 86_400_000)})
  `;
  return goal.id;
}

async function withPerson(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  db: postgres.Sql,
  width: number,
  body: (page: Page, personId: string) => Promise<void>,
) {
  const context = await browser.newContext({
    baseURL: baseURL!,
    storageState: person.sessionFile,
    viewport: { width, height: 900 },
  });
  try {
    const page = await context.newPage();
    await body(page, person.id);
  } finally {
    await context.close();
    await db`delete from goals.commitments where user_id = ${person.id}`;
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
}

async function open(page: Page): Promise<void> {
  await visit(page, "/semana");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

for (const width of [360, 1280]) {
  test(`at ${width} a goal that ended this week reads «terminó el <día> · ver» and opens`, async ({
    browser,
    baseURL,
    person,
    db,
  }) => {
    test.skip(isMonday, MONDAY_ENDED);
    await withPerson(browser, baseURL, person, db, width, async (page, personId) => {
      const stamp = Date.now();
      const name = `Meta terminada ${stamp}`;
      const openName = `Meta viva ${stamp}`;
      const lastDay = shift(today, -1);
      await seedGoal(db, personId, openName, shift(today, 30));
      const id = await seedGoal(db, personId, name, today);
      await open(page);
      // Beside it, the open goal always draws: an absent line is not an empty page.
      await expect(page.getByText(openName).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByText(`terminó el ${dayWords(lastDay)}`).filter({ visible: true })).toHaveCount(
        1,
      );
      await expect(page.getByText(/terminó ayer/)).toHaveCount(0);
      const link = page.getByRole("link", { name: `Abrir ${name}` }).filter({ visible: true });
      await expect(link).toHaveCount(1);
      await expect(page.getByText(name).filter({ visible: true })).toHaveCount(NAME_DRAWS);
      await expect(link).toHaveText("ver");
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/metas/${id}$`));
    });
  });

  test(`at ${width} a goal ended this week with only flexible commitments reads the line too`, async ({
    browser,
    baseURL,
    person,
    db,
  }) => {
    test.skip(isMonday, MONDAY_ENDED);
    await withPerson(browser, baseURL, person, db, width, async (page, personId) => {
      const stamp = Date.now();
      const name = `Meta flexible ${stamp}`;
      const openName = `Meta viva ${stamp}`;
      await seedGoal(db, personId, openName, shift(today, 30));
      const id = await seedGoal(db, personId, name, today);
      await db`delete from goals.commitments where goal_id = ${id}`;
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
        values (${personId}, ${id}, 'Empuje', 'times_per_week', 3, 'tap', ${new Date(Date.now() - 60 * 86_400_000)})
      `;
      await open(page);
      await expect(page.getByText(openName).filter({ visible: true }).first()).toBeVisible();
      await expect(
        page.getByText(`terminó el ${dayWords(shift(today, -1))}`).filter({ visible: true }),
      ).toHaveCount(1);
      const link = page.getByRole("link", { name: `Abrir ${name}` }).filter({ visible: true });
      await expect(link.filter({ hasText: "ver" })).toHaveCount(1);
      await expect(link).toHaveCount(1);
      await expect(page.getByText(name).filter({ visible: true })).toHaveCount(NAME_DRAWS);
    });
  });

  test(`at ${width} a goal whose last day was last Sunday leaves the week: no name, no line`, async ({
    browser,
    baseURL,
    person,
    db,
  }) => {
    await withPerson(browser, baseURL, person, db, width, async (page, personId) => {
      const stamp = Date.now();
      const name = `Meta semana pasada ${stamp}`;
      const openName = `Meta viva ${stamp}`;
      // The horizon is the week's own Monday: the goal's last day is Sunday.
      const [monday] = weekOf(today);
      await seedGoal(db, personId, openName, shift(today, 30));
      await seedGoal(db, personId, name, monday);
      await open(page);
      await expect(page.getByText(openName).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByText(name).filter({ visible: true })).toHaveCount(0);
      await expect(page.getByText(/terminó/).filter({ visible: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: `Abrir ${name}` })).toHaveCount(0);
    });
  });

  test(`at ${width} a goal still open shows no ended line`, async ({ browser, baseURL, person, db }) => {
    await withPerson(browser, baseURL, person, db, width, async (page, personId) => {
      const name = `Meta abierta ${Date.now()}`;
      await seedGoal(db, personId, name, shift(today, 30));
      await open(page);
      await expect(page.getByText(name, { exact: false }).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByText(/terminó/).filter({ visible: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: `Abrir ${name}` })).toHaveCount(0);
    });
  });
}

// DESIGN: the week draws no goal group with neither rows nor an ended line, so
// a goal that ended this week with nothing to mark still says when it ended.
test("at 360 a goal ended this week with no commitment still reads «terminó el <día> · ver»", async ({
  browser,
  baseURL,
  person,
  db,
}) => {
  test.skip(isMonday, MONDAY_ENDED);
  await withPerson(browser, baseURL, person, db, 360, async (page, personId) => {
    const stamp = Date.now();
    const name = `Meta sin filas ${stamp}`;
    const openName = `Meta viva ${stamp}`;
    await seedGoal(db, personId, openName, shift(today, 30));
    const id = await seedGoal(db, personId, name, today);
    await db`delete from goals.commitments where goal_id = ${id}`;
    await open(page);
    await expect(page.getByText(openName).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(`terminó el ${dayWords(shift(today, -1))}`).filter({ visible: true })).toHaveCount(
      1,
    );
    const link = page.getByRole("link", { name: `Abrir ${name}` }).filter({ visible: true });
    await expect(link).toHaveCount(1);
    await expect(page.getByText(name).filter({ visible: true })).toHaveCount(NAME_DRAWS);
  });
});
