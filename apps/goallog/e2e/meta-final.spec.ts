import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { dayBefore, horizonForWeeks } from "@/lib/day/weeks";
import { addWeeksToCivilDate, civilDateToDate, civilDayMonthYear, todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import goal from "../messages/es/goal.json";

// RP-25, RP-27, RP-24: «Mover el final» opens on the goal's own last day and
// moving nothing writes nothing; an archived goal past its end says it ended.
// Every goal belongs to the spec's disposable person and is deleted by id.

const WIDTHS: [number, number][] = [
  [390, 844],
  [1440, 900],
];

const INVALID = goal.errors.horizonWeeksInvalid;
const MOVE = goal.horizon.confirm;
const WEEKS_LABEL = /^semanas, contando esta$/;

// Opened Monday 2026-08-24, last day Thursday 2027-09-30: a horizon that is
// not a week's edge, the way a goal written with an end date lands.
const OPENED = "2026-08-24";
const MID_WEEK_HORIZON = "2027-10-01";

// RP-108: the sheet counts from this week, so a goal's horizon is the Monday `weeks` after this week's Monday.
const fromThisWeek = (weeks: number) => addWeeksToCivilDate(weekOf(todayInZone())[0], weeks);
// The week of its last day, counting this one as 1 (plain arithmetic, never the app's helpers).
function weeksFromThisTo(lastDay: string): number {
  const days = civilDateToDate(weekOf(lastDay)[0]).getTime() - civilDateToDate(weekOf(todayInZone())[0]).getTime();
  return Math.round(days / 86_400_000 / 7) + 1;
}

async function seed(
  db: postgres.Sql,
  personId: string,
  opts: { createdAt: string; horizon: string; archived?: boolean },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${personId}, ${`Meta final ${Date.now()}`}, ${opts.horizon}::date,
            ${new Date(`${opts.createdAt}T17:00:00Z`)}, ${opts.archived ? new Date() : null})
    returning id
  `;
  return row.id;
}

async function horizonOf(db: postgres.Sql, goalId: string): Promise<string> {
  const [row] = await db<{ horizon: string }[]>`
    select horizon::text as horizon from goals.goals where id = ${goalId}
  `;
  return row.horizon;
}

async function openSheet(page: Page, goalId: string) {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

function longDay(day: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

for (const [width, height] of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    async function withPage(
      { person, browser, baseURL }: { person: { sessionFile: string }; browser: import("@playwright/test").Browser; baseURL: string | undefined },
      run: (page: Page) => Promise<void>,
    ) {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height },
      });
      try {
        await run(await context.newPage());
      } finally {
        await context.close();
      }
    }

    test("the sheet opens on the goal's last day, not on a week's edge (RP-25)", async ({ person, browser, baseURL, db }) => {
      const goalId = await seed(db, person.id, { createdAt: OPENED, horizon: MID_WEEK_HORIZON });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          await page.goto(`/metas/${goalId}`);
          await expect(page.getByText(/ · hasta el 30 sep 2027$/)).toBeVisible();
          const sheet = await openSheet(page, goalId);
          await expect(sheet.getByText(`termina el ${civilDayMonthYear(dayBefore(MID_WEEK_HORIZON))}`)).toBeVisible();
          expect(longDay(dayBefore(MID_WEEK_HORIZON))).toBe("jueves, 30 de septiembre");
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("pressing «Moverlo» untouched writes nothing and closes the sheet (RP-25)", async ({ person, browser, baseURL, db }) => {
      const goalId = await seed(db, person.id, { createdAt: OPENED, horizon: MID_WEEK_HORIZON });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          const sheet = await openSheet(page, goalId);
          const actionCalls: string[] = [];
          page.on("request", (request) => {
            if (request.method() === "POST" && request.headers()["next-action"]) actionCalls.push(request.url());
          });
          await sheet.getByRole("button", { name: MOVE }).click();
          await expect(sheet).toBeHidden();
          expect(actionCalls).toEqual([]);
          expect(await horizonOf(db, goalId)).toBe(MID_WEEK_HORIZON);
          await expect(page.getByText(/ · hasta el 30 sep 2027$/)).toBeVisible();
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("a changed count moves to the week's edge it names (RP-25)", async ({ person, browser, baseURL, db }) => {
      const goalId = await seed(db, person.id, { createdAt: OPENED, horizon: MID_WEEK_HORIZON });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          const sheet = await openSheet(page, goalId);
          const field = sheet.getByLabel(WEEKS_LABEL);
          const opening = Number(await field.inputValue());
          expect(opening).toBe(weeksFromThisTo(dayBefore(MID_WEEK_HORIZON)));
          const target = fromThisWeek(opening + 4);
          await field.fill(String(opening + 4));
          await expect(sheet.getByText(`termina el ${civilDayMonthYear(dayBefore(target))}`)).toBeVisible();
          expect(longDay(dayBefore(target))).toMatch(/^domingo, /);
          await sheet.getByRole("button", { name: MOVE }).click();
          await expect(sheet).toBeHidden();
          await expect.poll(() => horizonOf(db, goalId)).toBe(target);
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("a goal written in whole weeks still ends on its Sunday (RP-25)", async ({ person, browser, baseURL, db }) => {
      const horizon = fromThisWeek(12);
      const goalId = await seed(db, person.id, { createdAt: OPENED, horizon });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          const sheet = await openSheet(page, goalId);
          await expect(sheet.getByLabel(WEEKS_LABEL)).toHaveValue("12");
          await expect(sheet.getByText(`termina el ${civilDayMonthYear(dayBefore(horizon))}`)).toBeVisible();
          expect(longDay(dayBefore(horizon))).toMatch(/^domingo, /);
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("a count that is not a week count says why as it is typed (RP-25)", async ({ person, browser, baseURL, db }) => {
      const horizon = fromThisWeek(12);
      const goalId = await seed(db, person.id, { createdAt: OPENED, horizon });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          const sheet = await openSheet(page, goalId);
          const field = sheet.getByLabel(WEEKS_LABEL);
          await field.fill("");
          await field.fill("0");
          await expect(sheet.getByText(INVALID)).toBeVisible();
          await expect(field).toHaveAttribute("aria-invalid", "true");
          await expect(sheet.getByText(/^termina el /)).toHaveCount(0);
          await field.fill("12");
          await expect(sheet.getByText(INVALID)).toHaveCount(0);
          await expect(field).not.toHaveAttribute("aria-invalid", "true");
          await expect(sheet.getByText(`termina el ${civilDayMonthYear(dayBefore(horizon))}`)).toBeVisible();
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("an archived goal past its end says when it ended (RP-24)", async ({ person, browser, baseURL, db }) => {
      const goalId = await seed(db, person.id, { createdAt: "2026-02-02", horizon: "2026-08-01", archived: true });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          await page.goto(`/metas/${goalId}`);
          await expect(page.getByText("terminó el viernes 31 de julio de 2026")).toBeVisible();
          await expect(page.getByText(/semanas? · hasta el /)).toHaveCount(0);
          await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(0);
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });

    test("an archived goal not past its end keeps its weeks line (RP-24)", async ({ person, browser, baseURL, db }) => {
      const today = todayInZone();
      const horizon = horizonForWeeks(today, 12);
      expect(horizon > today).toBe(true);
      const goalId = await seed(db, person.id, { createdAt: today, horizon, archived: true });
      try {
        await withPage({ person, browser, baseURL }, async (page) => {
          await page.goto(`/metas/${goalId}`);
          await expect(page.getByText(/^12 semanas · hasta el /)).toBeVisible();
          await expect(page.getByText(/^terminó el /)).toHaveCount(0);
        });
      } finally {
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });
  });
}

test("the end line and its sheet hold at 360 (RNP-07)", async ({ person, browser, baseURL, db }) => {
  const goalId = await seed(db, person.id, { createdAt: OPENED, horizon: MID_WEEK_HORIZON });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/ · hasta el 30 sep 2027$/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const sheet = await openSheet(page, goalId);
    await expect(sheet.getByText(`termina el ${civilDayMonthYear(dayBefore(MID_WEEK_HORIZON))}`)).toBeVisible();
    await sheet.getByLabel(WEEKS_LABEL).fill("0");
    await expect(sheet.getByText(INVALID)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
