import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// RP-74 + the 2026-10-11 decision: a first-month share that rounds to 0 draws no
// figure on Hoy (it reads as a month with no amount); the goal keeps its 0.
// Goals open today, so the share is floor(rhythm × daysLeft / monthLength) with
// daysLeft counting today. The rhythms are chosen from today's numbers: the
// largest one that rounds to 0, and one whose share is exactly daysLeft.

const today = todayInZone();
const OPENED = `${today}T12:00:00Z`;
const month = today.slice(0, 7);
const length = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const daysLeft = length - Number(today.slice(8, 10)) + 1;
// On the 1st every rhythm of 1 or more plans at least a day: no share rounds to 0.
const zeroRhythm = Math.ceil(length / daysLeft) - 1;
const noZeroShare = zeroRhythm < 1;
const shareRhythm = length;
const monthName = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));

async function seedGoal(db: postgres.Sql, personId: string, name: string, unit: string, rhythm: number) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${name}, '2099-12-31'::date, ${unit}, ${unit}, ${rhythm}, ${OPENED}::timestamptz)
    returning id
  `;
  return goal.id;
}

test.describe("Hoy, a goal opened late in a month", () => {
  test("a rhythm whose share rounds to 0 draws no «0 de 0» on Hoy and reads as a month with no amount", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    test.skip(noZeroShare, "the 1st: no rhythm of 1 or more has a share that rounds to 0");
    const stamp = Date.now();
    const zero = `Correr ${stamp}`;
    const control = `Estudiar ${stamp}`;
    const zeroId = await seedGoal(db, person.id, zero, "kilómetros", zeroRhythm);
    // A goal with a share keeps the «este mes» block on screen, so the zero goal's absence is
    // the guard's doing and not an empty page.
    const controlId = await seedGoal(db, person.id, control, "minutos", shareRhythm);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
      await expect(block).toContainText(control);
      // A month with no amount and no task draws no line for the goal at all.
      await expect(block).not.toContainText(zero);
      await expect(block).not.toContainText(/0\s*de\s*0\s*kil/);
      await expect(page.getByText(/\b0\s*de\s*0\b/).locator("visible=true")).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where id in (${zeroId}, ${controlId}) and user_id = ${person.id}`;
    }
  });

  test("a rhythm with a share above 0 keeps it on Hoy: «de N min»", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Inglés ${stamp}`;
    const id = await seedGoal(db, person.id, name, "minutos", shareRhythm);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
      await expect(block).toContainText(name);
      await expect(block).toContainText(new RegExp(`de ${daysLeft} min\\b`));
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });

  test("the goal's own page keeps the 0 of a rounded-down share (RP-74)", async ({ person, browser, baseURL, db }) => {
    test.skip(noZeroShare, "the 1st: no rhythm of 1 or more has a share that rounds to 0");
    const stamp = Date.now();
    const id = await seedGoal(db, person.id, `Correr ${stamp}`, "kilómetros", zeroRhythm);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${id}`);
      await expect(page.locator("main")).toHaveCount(1);
      // The month's own figure on the goal page, as RP-74 rounds it.
      await expect(page.locator("main")).toContainText(new RegExp(`${monthName}\\s*0\\s*de\\s*0\\s*kilómetros`, "i"));
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });

  test("a zero share on a goal that counts tasks reads as no amount: the reached figure, then its tasks", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    test.skip(noZeroShare, "the 1st: no rhythm of 1 or more has a share that rounds to 0");
    const stamp = Date.now();
    const name = `Correr ${stamp}`;
    const id = await seedGoal(db, person.id, name, "kilómetros", zeroRhythm);
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, position)
      values (${person.id}, ${id}, ${`Primera ${stamp}`}, ${`${month}-01`}::date, 1),
             (${person.id}, ${id}, ${`Segunda ${stamp}`}, ${`${month}-01`}::date, 2)
    `;
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
      await expect(block).toContainText(name);
      await expect(block).toContainText(/0\s*kilómetros\s*· 0 de 2 tareas/);
      await expect(block).not.toContainText(/0\s*de\s*0\s*kil/);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });

  test("a month budget of 0 the person typed keeps its line on Hoy: «0 de 0 kilómetros»", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Correr ${stamp}`;
    // A rhythm with a share, so only the typed budget makes the planned amount 0.
    const id = await seedGoal(db, person.id, name, "kilómetros", shareRhythm);
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${id}, ${`${month}-01`}::date, 0)
    `;
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const block = page.locator("section").filter({ hasText: "este mes" }).locator("visible=true");
      await expect(block).toContainText(name);
      await expect(block).toContainText(/0\s*de\s*0\s*kil/);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });
});
