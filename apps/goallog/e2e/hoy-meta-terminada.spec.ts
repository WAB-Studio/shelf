import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, todayHeading, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// Hoy says when a goal ended (`HoyMetaTerminada.dc.html`): «X terminó ayer ·
// ver» for the day after, the weekday later in the same week, nothing once
// the week it ended in is over. Every test seeds horizons relative to today.
// Paths by day: Monday asserts the lines absent (yesterday and the day before
// are last week); Tuesday draws «ayer» only; Wednesday to Sunday draw both.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
// 0 is Monday.
const todayIndex = (civilDateToDate(today).getUTCDay() + 6) % 7;
const weekStart = shift(today, -todayIndex);
// Whether the day `by` days ago belongs to this week, so its line draws.
const inThisWeek = (by: number) => todayIndex >= by;
const MONDAY_YESTERDAY = "el lunes la línea de ayer no existe (su semana ya pasó); lo cubre la corrida de otro día";
const EARLY_WEEK_TWO_DAYS = "lunes y martes dos días atrás cae en la semana pasada; lo cubre la corrida de otro día";

// ICU's Spanish, never the catalogue's list the screen reads.
function dayWords(day: string): string {
  const parts = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .formatToParts(civilDateToDate(day));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("weekday")} ${part("day")} de ${part("month")} de ${part("year")}`;
}

// The last day is `lastDay`, so the horizon is the day after.
async function seedEnded(db: postgres.Sql, personId: string, name: string, lastDay: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${shift(lastDay, 1)}, ${new Date(Date.now() - 60 * 86_400_000)}) returning id
  `;
  return goal.id;
}

// An open goal keeps Hoy from being the all-ended card. It asks something, or
// the phone draws no section for it (RP-47).
async function seedOpen(db: postgres.Sql, personId: string, name: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${shift(today, 60)}, now() - interval '3 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${`Tocar ${name}`}, 'daily', 'tap', now() - interval '3 days')
  `;
}

// Rows are dropped here; the person's identity is the suite run's to drop.
async function withPerson(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  db: postgres.Sql,
  body: (page: Page, personId: string) => Promise<void>,
) {
  const context = await browser.newContext({ baseURL: baseURL!, storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await body(page, person.id);
  } finally {
    await context.close();
    await db`delete from goals.facts where user_id = ${person.id}`;
    await db`delete from goals.one_offs where user_id = ${person.id}`;
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
}

// `goto` returns while the loading skeleton still stands.
async function open(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.locator("main :is(h1, p, a, button, input)").first()).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(todayHeading(page)).toHaveCount(1);
}

test("a goal that ended yesterday reads «terminó ayer · ver»", async ({ browser, baseURL, person, db }) => {
  test.skip(!inThisWeek(1), MONDAY_YESTERDAY);
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const name = `Dejar el azúcar ${Date.now()}`;
    const openName = `Abierta ${Date.now()}`;
    await seedOpen(db, personId, openName);
    await seedEnded(db, personId, name, shift(today, -1));
    await open(page);
    await expect(page.getByText(openName).first()).toBeVisible();
    await expect(page.getByText(`${name} terminó ayer`)).toHaveCount(1);
    await expect(page.getByText(/terminó el /)).toHaveCount(0);
  });
});

test("a goal that ended two days ago this week names the day", async ({ browser, baseURL, person, db }) => {
  test.skip(!inThisWeek(2), EARLY_WEEK_TWO_DAYS);
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const name = `Dejar el café ${Date.now()}`;
    const openName = `Abierta ${Date.now()}`;
    await seedOpen(db, personId, openName);
    await seedEnded(db, personId, name, shift(today, -2));
    await open(page);
    await expect(page.getByText(openName).first()).toBeVisible();
    await expect(page.getByText(`${name} terminó el ${dayWords(shift(today, -2))}`)).toHaveCount(1);
    await expect(page.getByText(/terminó ayer/)).toHaveCount(0);
  });
});

test("a goal that ended last week shows nothing", async ({ browser, baseURL, person, db }) => {
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const name = `Meta de la semana pasada ${Date.now()}`;
    await seedOpen(db, personId, `Abierta ${Date.now()}`);
    // The Sunday before this week: yesterday on a Monday, and still not this week's.
    await seedEnded(db, personId, name, shift(weekStart, -1));
    await open(page);
    await expect(page.getByText(`Abierta`, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
    await expect(page.getByText(/ terminó /)).toHaveCount(0);
  });
});

test("«ver» opens the goal that ended", async ({ browser, baseURL, person, db }) => {
  test.skip(!inThisWeek(1), MONDAY_YESTERDAY);
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const name = `Meta que ver ${Date.now()}`;
    const openName = `Abierta ${Date.now()}`;
    await seedOpen(db, personId, openName);
    const id = await seedEnded(db, personId, name, shift(today, -1));
    await open(page);
    await expect(page.getByText(openName).first()).toBeVisible();
    const link = page.getByRole("link", { name: `Abrir ${name}` });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText("ver");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/metas/${id}$`));
    await expect(page.getByText(name).first()).toBeVisible();
  });
});

test("at 1280 the line sits under the date and above the goals", async ({ browser, baseURL, person, db }) => {
  test.skip(!inThisWeek(1), MONDAY_YESTERDAY);
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const stamp = Date.now();
    const openName = `Abierta ${stamp}`;
    const name = `Reciente ${stamp}`;
    await seedOpen(db, personId, openName);
    await seedEnded(db, personId, name, shift(today, -1));
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const line = page.getByText(`${name} terminó ayer`);
    await expect(line).toHaveCount(1);
    const box = async (locator: Locator) => (await boxOf(locator));
    // The header is the date (DESIGN «Hoy, 2026-11-01»): the line sits under it.
    const t = await box(page.getByRole("main").getByRole("heading", { level: 1 }));
    const g = await box(page.getByText(openName).first());
    expect(g.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
    const l = await box(line);
    expect(l.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
    expect(g.y).toBeGreaterThan(l.y);
    expect(Math.abs(l.x - t.x)).toBeLessThan(2);
  });
});

test("several goals ended this week read one line each, in plan order (RP-47)", async ({ browser, baseURL, person, db }) => {
  test.skip(!inThisWeek(1), MONDAY_YESTERDAY);
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const stamp = Date.now();
    const older = `Antigua ${stamp}`;
    const newer = `Reciente ${stamp}`;
    const openName = `Abierta ${stamp}`;
    await seedOpen(db, personId, openName);
    await seedEnded(db, personId, older, shift(today, -2));
    await seedEnded(db, personId, newer, shift(today, -1));
    await open(page);
    await expect(page.getByText(openName).first()).toBeVisible();
    // Tuesday draws only the newer one, Wednesday on both.
    const expected = [
      ...(inThisWeek(2) ? [`${older} terminó el ${dayWords(shift(today, -2))}`] : []),
      ...(inThisWeek(1) ? [`${newer} terminó ayer`] : []),
    ];
    const lines = page.getByText(/ terminó (ayer|el )/);
    await expect(lines).toHaveCount(expected.length);
    const texts = await lines.allTextContents();
    // Seeded older first, so plan order puts it above the more recent one.
    expected.forEach((line, index) => expect(texts[index]).toContain(line));
  });
});

test("when every goal has ended the card names the last one and the line is not repeated", async ({
  browser,
  baseURL,
  person,
  db,
}) => {
  await withPerson(browser, baseURL, person, db, async (page, personId) => {
    const name = `Última ${Date.now()}`;
    await seedEnded(db, personId, name, shift(today, -1));
    await open(page);
    await expect(page.getByText(`${name} terminó el`)).toHaveCount(1);
    await expect(page.getByText(/terminó ayer/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Abrir ${name}` })).toHaveCount(0);
  });
});
