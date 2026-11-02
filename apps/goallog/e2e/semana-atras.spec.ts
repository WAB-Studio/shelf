import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import day from "../messages/es/day.json";
import { test, expect, visit, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// RP-44, RP-16, RP-06 on Semana: ‹ › step a week at a time, read-only beyond
// seven days (`SemanaPasada.dc.html`, `SemanaPrimera.dc.html`,
// `SemanaPasadaArchivada.dc.html`). The `person` is the worker's own, so the
// oldest goal it holds is the one seeded here and ‹ ends where this spec says.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

function weekdayIndex(day: string): number {
  return (civilDateToDate(day).getUTCDay() + 6) % 7;
}

function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// «Del 21 al 27 de octubre», or «Del 28 sep al 4 oct» across a month.
function rangeOf(monday: string): string {
  const sunday = shift(monday, 6);
  const part = (day: string, withMonth: boolean) =>
    `${Number(day.slice(8, 10))}${withMonth ? ` ${MONTHS[Number(day.slice(5, 7)) - 1]}` : ""}`;
  const crosses = monday.slice(0, 7) !== sunday.slice(0, 7);
  const range = `Del ${part(monday, crosses)} al ${part(sunday, crosses)}`;
  return crosses ? range : `${range} de ${day.monthLong[Number(sunday.slice(5, 7)) - 1]}`;
}

const today = todayInZone();
const thisMonday = shift(today, -weekdayIndex(today));
const mondayAgo = (weeks: number) => shift(thisMonday, -7 * weeks);

// Noon Bogotá on the civil day: the same civil day in every zone near it.
function noonOf(day: string): Date {
  return new Date(`${day}T17:00:00Z`);
}

const OLD_GOAL = "Meta vieja";
const OLD_COMMITMENT = "Anki viejo";
const ARCHIVED_GOAL = "Dejar el azúcar";
// The Wednesday of the week four back.
const factDay = shift(mondayAgo(4), 2);

async function seed(db: postgres.Sql, person: Person) {
  const [old] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${OLD_GOAL}, ${shift(today, 60)}, ${noonOf(shift(today, -42))}) returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${old.id}, ${OLD_COMMITMENT}, 'daily', 'tap', ${noonOf(shift(today, -42))}) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day)
    values (${person.id}, ${old.id}, ${commitment.id}, ${factDay}::date)
  `;
  const [archived] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${person.id}, ${ARCHIVED_GOAL}, ${shift(today, 30)}, ${noonOf(shift(today, -35))}, ${noonOf(shift(thisMonday, -9))})
    returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${archived.id}, 'Sin postre', 'daily', 'tap', ${noonOf(shift(today, -35))})
  `;
  return [old.id, archived.id];
}

async function withWeeks(
  browser: Browser,
  baseURL: string | undefined,
  db: postgres.Sql,
  person: Person,
  width: number,
  run: (page: Page) => Promise<void>,
) {
  const goalIds = await seed(db, person);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await run(page);
  } finally {
    await context.close();
    await db`delete from goals.goals where id in ${db(goalIds)}`;
  }
}

const prev = (page: Page) => page.getByRole("link", { name: "Semana anterior" });
const next = (page: Page) => page.getByRole("link", { name: "Semana siguiente" });

test("‹ four times lands on the week holding the fact, done and read-only; › steps back to this week (RP-44, RP-16, RP-06)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto("/semana");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(thisMonday));
    // The seeded goal ends two months out: this week steps forward too (RP-142).
    await expect(next(page)).toHaveAttribute("href", `/semana?semana=${shift(thisMonday, 7)}`);

    for (let weeks = 1; weeks <= 4; weeks++) {
      await prev(page).click();
      await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${mondayAgo(weeks)}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(weeks)));
    }

    const mark = (day: string) =>
      page.getByRole("img", { name: new RegExp(`^${OLD_COMMITMENT}, ${longName(day)}: `) });
    await expect(mark(factDay)).toHaveAccessibleName(`${OLD_COMMITMENT}, ${longName(factDay)}: hecho`);
    await expect(mark(factDay)).toHaveAttribute("data-state", "declared");
    await expect(mark(shift(factDay, 1))).toHaveAttribute("data-state", "empty");
    // The goal archived two weeks ago governed this week: it stays, dated.
    await expect(
      page
        .getByText(new RegExp(`^${ARCHIVED_GOAL} · archivada el \\d+ \\w+ \\d{4}$`, "i"))
        .locator("visible=true"),
    ).toHaveCount(1);
    await expect(page.getByRole("link", { name: /^Abrir el (?!chat$)/ })).toHaveCount(0);
    await expect(page.getByText(/· hoy/).locator("visible=true")).toHaveCount(0);

    for (let weeks = 3; weeks >= 1; weeks--) {
      await next(page).click();
      await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${mondayAgo(weeks)}$`));
    }
    await next(page).click();
    await expect(page).toHaveURL(/\/semana$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(thisMonday));
    await expect(next(page)).toHaveAttribute("href", `/semana?semana=${shift(thisMonday, 7)}`);
  });
});

test("the oldest week has no ‹, the one after it has; a goal archived since is not in the weeks after it (RP-44, RP-24)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${mondayAgo(6)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(6)));
    await expect(prev(page)).toHaveCount(0);
    await expect(next(page)).toHaveCount(1);
    // The archived goal was opened five weeks back: not yet in this one.
    await expect(page.getByText(new RegExp(`^${ARCHIVED_GOAL}`, "i"))).toHaveCount(0);

    await page.goto(`/semana?semana=${mondayAgo(5)}`);
    await expect(prev(page)).toHaveCount(1);

    // Archived on that week's Saturday, before its Sunday (RP-24): gone from it, whatever weekday the suite runs.
    await page.goto(`/semana?semana=${mondayAgo(2)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(2)));
    await expect(page.getByText(new RegExp(`^${ARCHIVED_GOAL}`, "i"))).toHaveCount(0);
  });
});

test("a week past the furthest goal's end lands on the last week; a malformed one on /semana (RP-142)", async ({ browser, baseURL, db, person }) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto("/semana?semana=nada");
    await expect(page).toHaveURL(/\/semana$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(thisMonday));
    const landed: string[] = [];
    for (const param of [shift(today, 400), shift(today, 2000)]) {
      await page.goto(`/semana?semana=${param}`);
      // `(app)/loading.tsx` streams first, so the redirect lands later; the pattern below matches the asked address too.
      await expect(page).not.toHaveURL(new RegExp(`semana=${param}$`));
      await expect(page).toHaveURL(/\/semana\?semana=\d{4}-\d{2}-\d{2}$/);
      await expect(next(page)).toHaveCount(0);
      landed.push(new URL(page.url()).searchParams.get("semana")!);
    }
    expect(landed[0]).toBe(landed[1]);
    expect(landed[0] < shift(today, 400)).toBe(true);
  });
});

test("within seven days a day is still a link and opens /dia/<day> (RP-06)", async ({ browser, baseURL, db, person }) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${mondayAgo(1)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(1)));
    const lastWeek = Array.from({ length: 7 }, (_, i) => shift(mondayAgo(1), i));
    const reachable = lastWeek.filter((day) => day >= shift(today, -7));
    await expect(page.getByRole("link", { name: /^Abrir el (?!chat$)/ })).toHaveCount(reachable.length);
    const sunday = lastWeek[6];
    await page.getByRole("link", { name: new RegExp(`^Abrir el ${longName(sunday)}$`) }).click();
    await expect(page).toHaveURL(new RegExp(`/dia/${sunday}$`));
  });
});

for (const width of [360, 390, 1280, 1440]) {
  test(`at ${width} a past week has no overflow and its ‹ › are 48px (RP-44, RNP-07, RNP-16)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await withWeeks(browser, baseURL, db, person, width, async (page) => {
      await page.goto(`/semana?semana=${mondayAgo(4)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(4)));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const link of [prev(page), next(page)]) {
        const box = (await boxOf(link));
        expect(box.width).toBeGreaterThanOrEqual(48);
        expect(box.height).toBeGreaterThanOrEqual(48);
      }
      if (width >= 1024) {
        const table = (await boxOf(page.getByRole("table")));
        if (width === 1440) expect(table.width).toBeGreaterThan(1000);
        expect(table.width).toBeGreaterThan(width * 0.6);
      }
    });
  });
}

// Module 671, board `SemanaPasoAtras`: the steps are words, not a lone ‹ ›.
const visibleText = (link: ReturnType<typeof prev>) => link.evaluate((el) => (el as HTMLElement).innerText);

function crossingMonday(): string {
  for (let weeks = 1; weeks <= 5; weeks++) {
    const monday = mondayAgo(weeks);
    if (monday.slice(0, 7) !== shift(monday, 6).slice(0, 7)) return monday;
  }
  return mondayAgo(3);
}

for (const width of [390, 1440]) {
  test(`at ${width} the steps read «semana anterior» and «semana siguiente», 48px tall, and lead to the adjacent Mondays (RP-44)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await withWeeks(browser, baseURL, db, person, width, async (page) => {
      await page.goto(`/semana?semana=${mondayAgo(2)}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(2)));
      expect((await visibleText(prev(page))).toLowerCase()).toContain("semana anterior");
      expect(await visibleText(prev(page))).toContain("semana anterior");
      expect(await visibleText(next(page))).toContain("semana siguiente");
      await expect(prev(page)).toHaveAttribute("href", `/semana?semana=${mondayAgo(3)}`);
      await expect(next(page)).toHaveAttribute("href", `/semana?semana=${mondayAgo(1)}`);
      for (const link of [prev(page), next(page)]) {
        const box = (await boxOf(link));
        expect(box.height).toBeGreaterThanOrEqual(48);
      }
      await page.goto(`/semana?semana=${mondayAgo(1)}`);
      await expect(next(page)).toHaveAttribute("href", /\/semana\/?$/);
    });
  });
}

test("at 390 the steps sit on their own row above the title, one at each edge (RP-44)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await visit(page, `/semana?semana=${mondayAgo(2)}`);
    const h1 = (await boxOf(page.getByRole("heading", { level: 1 })));
    const p = (await boxOf(prev(page)));
    const n = (await boxOf(next(page)));
    expect(p.y + p.height).toBeLessThanOrEqual(h1.y);
    expect(n.y + n.height).toBeLessThanOrEqual(h1.y);
    expect(Math.abs(p.y - n.y)).toBeLessThanOrEqual(2);
    expect(p.x).toBeLessThan(195);
    expect(p.x).toBeLessThanOrEqual(40);
    expect(n.x + n.width).toBeGreaterThan(195);
    expect(n.x + n.width).toBeGreaterThanOrEqual(390 - 40);
    expect(p.x + p.width).toBeLessThanOrEqual(n.x);
  });
});

test("at 1280 the steps sit to the right of the title, on the header row (RP-44)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 1280, async (page) => {
    await visit(page, `/semana?semana=${mondayAgo(2)}`);
    const h1 = (await boxOf(page.getByRole("heading", { level: 1 })));
    const p = (await boxOf(prev(page)));
    const n = (await boxOf(next(page)));
    expect(p.x).toBeGreaterThan(h1.x + h1.width);
    expect(n.x).toBeGreaterThan(p.x);
    expect(p.y).toBeLessThan(h1.y + h1.height);
  });
});

test("the first week with a goal has no back step; › stays at the right edge (RP-44)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto(`/semana?semana=${mondayAgo(6)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(mondayAgo(6)));
    await expect(page.getByRole("link", { name: /semana anterior/i })).toHaveCount(0);
    expect(await page.getByText(/semana anterior/i).count()).toBe(0);
    const n = (await boxOf(next(page)));
    expect(n.x + n.width).toBeGreaterThanOrEqual(390 - 40);
  });
});

test("this week's next step reads «semana siguiente»; the back step stays at the left edge (RP-142)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  await withWeeks(browser, baseURL, db, person, 390, async (page) => {
    await page.goto("/semana");
    await expect(next(page)).toHaveCount(1);
    expect(await visibleText(next(page))).toContain("semana siguiente");
    const p = (await boxOf(prev(page)));
    expect(p.x).toBeLessThanOrEqual(40);
  });
});

for (const width of [360, 390, 1440]) {
  test(`at ${width} both words and a long title overflow nothing (RP-44, RNP-07)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await withWeeks(browser, baseURL, db, person, width, async (page) => {
      const monday = crossingMonday();
      await page.goto(`/semana?semana=${monday}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(monday));
      await expect(prev(page)).toBeVisible();
      await expect(next(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const link of [prev(page), next(page)]) {
        const box = (await boxOf(link));
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    });
  });
}
