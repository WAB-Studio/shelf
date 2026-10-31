import type { Page } from "@playwright/test";

import { test, expect, visit } from "./fixtures";
import { expectedMonths, figure } from "./habit-weeks";
import {
  MONTH_START,
  MONTH_WORD,
  TODAY,
  TODAY_INDEX,
  WEEK_START,
  drawn,
  longDay,
  seedFact,
  seedGoal,
  seedHabit,
  seedTap,
  shift,
} from "./sin-final-seed";

// `SemanaHabitoSuelto`, `MesHabitoSuelto`, `HoySinFinal` on Semana (RP-99, RP-100; P7 = B; decisions of 2026-10-13):
// Semana and «Mes» draw the loose habits in a «Hábitos» group after the goals (never «Sin meta»), and a goal with no
// end says nothing of its end. Every date is read from the day the app reads, so each test runs any day of the week.

const FACES = [360, 1280];
const GROUP = "hábitos";
const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const text = async (page: Page) => drawn(await page.locator("main").innerText());

for (const width of FACES) {
  test(`at ${width} Semana draws the habits in the «Hábitos» group after the goals, each with its own days`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: filtering `goalId` null out of the week (`week-table-face`), or a «Sin meta» label.
    const stamp = Date.now();
    const goalName = `Cuidado ${stamp}`;
    const kept = `Bañarse ${stamp}`;
    const water = `Tomar agua ${stamp}`;
    const stretch = `Estirar ${stamp}`;
    const call = `Llamar ${stamp}`;
    const goalId = await seedGoal(db, person.id, goalName, { horizon: shift(TODAY, 60) });
    await seedTap(db, person.id, goalId, kept);
    const waterId = await seedHabit(db, person.id, water, { kind: "daily" });
    await seedHabit(db, person.id, stretch, { kind: "weekdays", days: [1, 3, 5] });
    await seedHabit(db, person.id, call, { kind: "times_per_week", n: 1 });
    await seedFact(db, person.id, waterId, null, TODAY);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 1000 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/semana");
      const body = await text(page);
      const group = body.indexOf(GROUP);
      expect(group, "the «Hábitos» group is drawn").toBeGreaterThanOrEqual(0);
      expect(group).toBeGreaterThan(body.indexOf(kept.toLowerCase()));
      expect(body.indexOf(kept.toLowerCase())).toBeGreaterThan(body.indexOf(goalName.toLowerCase()));
      for (const name of [water, stretch, call]) expect(body.indexOf(name.toLowerCase())).toBeGreaterThan(group);
      expect(body).not.toContain("sin meta");
      // The group's own label carries no «semana N de M»: it is not a goal.
      expect(body.slice(group, body.indexOf(water.toLowerCase()))).not.toMatch(/semana \d+ de \d+/);
      expect(body).toContain("1 vez por semana · 0 de 1 esta semana");

      // Today's fact is today's mark; the days a weekday habit does not ask are «no pedía», and only those.
      await expect(
        page.getByRole("img", { name: `${water}, ${longDay(TODAY)}: hecho` }).locator("visible=true"),
      ).toHaveCount(1);
      const quiet = page.getByRole("img", { name: new RegExp(`^${stretch}, .*: no pedía$`) }).locator("visible=true");
      await expect(quiet).toHaveCount(4);
      for (const index of [1, 3, 5, 6]) {
        await expect(
          page.getByRole("img", { name: `${stretch}, ${longDay(shift(WEEK_START, index))}: no pedía` }).locator("visible=true"),
        ).toHaveCount(1);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
    }
  });
}

test("at 1280 the foot of Semana counts the habits: today's «N de M» holds the one marked", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: counting only the slots that belong to a goal.
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Cuidado ${stamp}`, { horizon: shift(TODAY, 60) });
  await seedTap(db, person.id, goalId, `Bañarse ${stamp}`);
  const waterId = await seedHabit(db, person.id, `Tomar agua ${stamp}`, { kind: "daily" });
  await seedHabit(db, person.id, `Estirar ${stamp}`, { kind: "daily" });
  await seedFact(db, person.id, waterId, null, TODAY);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/semana");
    await expect(page.getByRole("table").locator("tfoot td").nth(TODAY_INDEX)).toHaveText("1 de 3");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

for (const width of FACES) {
  for (const [label, week] of [["this week", WEEK_START], ["last week", shift(WEEK_START, -7)]] as const) {
    test(`at ${width}, ${label}: a goal with no end has no «terminó», no last week and no «semana N de M» in its label`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      // Kills: `horizon <= today` with a null horizon (an ended line for it), or the label's «· semana N de M» with no total.
      const stamp = Date.now();
      const name = `Leer ${stamp}`;
      const goalId = await seedGoal(db, person.id, name, { unit: "páginas" });
      await seedTap(db, person.id, goalId, `Leer diez ${stamp}`);
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await visit(page, `/semana?semana=${week}`);
        const body = await text(page);
        expect(body).toContain(name.toLowerCase());
        expect(body).toContain(`leer diez ${stamp}`);
        expect(body).not.toContain("terminó");
        expect(body).not.toContain("última semana");
        expect(body).not.toMatch(/semana \d+ de \d+/);
        expect(body).not.toMatch(/\b1969\b/);
        expect(body).not.toMatch(/\b1970\b/);
        await expect(page.getByText("Todavía no tienes una meta abierta.")).toHaveCount(0);
      } finally {
        await context.close();
        await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
      }
    });
  }
}

test("control: a goal with an end keeps «semana N de M» in its label", async ({ person, browser, baseURL, db }) => {
  // Not a kill: it proves the «semana N de M» assertion above can see the label when there is one.
  const name = `Leer ${Date.now()}`;
  const goalId = await seedGoal(db, person.id, name, { horizon: shift(TODAY, 90), unit: "páginas" });
  await seedTap(db, person.id, goalId, `Leer diez ${name}`);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/semana");
    expect(await text(page)).toMatch(/semana \d+ de \d+/);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

// «Mes» (P7 = B): a read-only row per habit, with its cadence and the days of the month it was met.
test("«Mes» draws the «Hábitos» group after the goal blocks, rows without a mark, with the days of the month met", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: no subquery of loose habits in `loadMonthAcross` (no group), a «Sin meta» label, a count over goals only.
  const dayOfMonth = Number(TODAY.slice(8, 10));
  test.skip(dayOfMonth === 1, "«1 de 1 días» on the 1st: the plural of a single day is not drawn; another day's run covers it");
  const stamp = Date.now();
  const goalName = `Cuidado ${stamp}`;
  const water = `Tomar agua ${stamp}`;
  const call = `Llamar ${stamp}`;
  const idle = `Sin hecho ${stamp}`;
  const goalId = await seedGoal(db, person.id, goalName, { horizon: shift(TODAY, 60), unit: "minutos", budget: 480 });
  const waterId = await seedHabit(db, person.id, water, { kind: "daily" }, { kind: "tap" }, { created: noonOf(MONTH_START) });
  const callCreated = shift(TODAY, -20);
  const callId = await seedHabit(db, person.id, call, { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(callCreated) });
  await seedHabit(db, person.id, idle, { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(callCreated) });
  for (let n = 0; n < dayOfMonth; n++) await seedFact(db, person.id, waterId, null, shift(MONTH_START, n));
  await seedFact(db, person.id, callId, null, TODAY);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/mes");
    const body = await text(page);
    const group = body.indexOf(GROUP);
    expect(group, "the «Hábitos» group is drawn in Mes").toBeGreaterThanOrEqual(0);
    expect(body.indexOf(goalName.toLowerCase())).toBeGreaterThanOrEqual(0);
    expect(group).toBeGreaterThan(body.indexOf(goalName.toLowerCase()));
    expect(body).not.toContain("sin meta");
    expect(body).toContain(`${water.toLowerCase()} todos los días · ${dayOfMonth} de ${dayOfMonth} días`);
    // A weekly habit reads its weeks (RP-109), never its days; the figure is the reference's for this month.
    const month = expectedMonths(callCreated, null, TODAY, new Set([TODAY]), 1).get(TODAY.slice(0, 7));
    if (month && month.counted > 0) {
      expect(body).toContain(`${call.toLowerCase()} 1 vez por semana · ${figure(0, month.counted)}`);
      expect(body).toContain(`${idle.toLowerCase()} 1 vez por semana · ${figure(0, month.counted)}`);
    }
    expect(body).not.toMatch(/1 vez por semana · \d+ días?/);
    // «1 días» as a whole number: «31 días» in the month block is a different figure.
    expect(body).not.toMatch(/(?<!\d)1 días/);
    // Read-only: Mes counts, it never marks.
    for (const name of [water, call, idle]) {
      await expect(page.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: new RegExp(name) })).toHaveCount(0);
    }
    expect(body).toContain(MONTH_WORD);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});

test("«Mes» counts a habit's days from the day it was created, not from the 1st", async ({ person, browser, baseURL, db }) => {
  // Kills: `createdOn: month` in `looseHabit` (a habit created today reads «0 de 13 días»).
  const dayOfMonth = Number(TODAY.slice(8, 10));
  const name = `Recién ${Date.now()}`;
  await seedHabit(db, person.id, name, { kind: "daily" }, { kind: "tap" }, { created: noonOf(TODAY) });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/mes");
    const body = await text(page);
    expect(body).toContain(`${name.toLowerCase()} todos los días · 0 de 1 día`);
    expect(dayOfMonth).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("«Mes» stops counting a habit's days the day after it was retired (RP-13)", async ({ person, browser, baseURL, db }) => {
  // Kills: `retiredAt: null` in `looseHabit` (a habit retired on the 2nd keeps asking through today).
  test.skip(Number(TODAY.slice(8, 10)) < 3, "retired on the 2nd it still asks 2 days only when today is the 3rd or later");
  const name = `Retirado ${Date.now()}`;
  const secondDay = shift(MONTH_START, 1);
  const id = await seedHabit(db, person.id, name, { kind: "daily" }, { kind: "tap" }, {
    created: noonOf(MONTH_START),
    retired: noonOf(secondDay),
  });
  await seedFact(db, person.id, id, null, MONTH_START);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 900 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/mes");
    expect(await text(page)).toContain(`${name.toLowerCase()} todos los días · 1 de 2 días`);
  } finally {
    await context.close();
  }
});
