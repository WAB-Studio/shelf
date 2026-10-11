import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// RP-74 + the 2026-10-11 decision: a first-month share that rounds to 0 draws no
// figure on Hoy (it reads as a month with no amount); the goal keeps its 0.
// Run under PULSAR_CLOCK=2026-10-31, the last day of a 31-day month: a rhythm of
// 20 km takes floor(20 × 1 / 31) = 0, one of 600 min takes floor(600 × 1 / 31) = 19.

const today = todayInZone();
const OPENED = `${today}T12:00:00Z`;

test.beforeAll(() => {
  if (today !== "2026-10-31") throw new Error(`run under PULSAR_CLOCK=2026-10-31, today is ${today}`);
});

async function seedGoal(db: postgres.Sql, personId: string, name: string, unit: string, rhythm: number) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${name}, '2099-12-31'::date, ${unit}, ${unit}, ${rhythm}, ${OPENED}::timestamptz)
    returning id
  `;
  return goal.id;
}

test.describe("Hoy, a goal opened on the last day of a month", () => {
  test("a 20 km rhythm opened on the 31st draws no «0 de 0» on Hoy and reads as a month with no amount", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const zero = `Correr ${stamp}`;
    const control = `Estudiar ${stamp}`;
    const zeroId = await seedGoal(db, person.id, zero, "kilómetros", 20);
    // A goal with a share keeps the «este mes» block on screen, so the zero goal's absence is
    // the guard's doing and not an empty page.
    const controlId = await seedGoal(db, person.id, control, "minutos", 600);
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

  test("a 600 min rhythm opened on the 31st keeps its share on Hoy: «de 19 min»", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const name = `Inglés ${stamp}`;
    const id = await seedGoal(db, person.id, name, "minutos", 600);
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
      await expect(block).toContainText(/\bde 19 min\b/);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });

  test("the goal's own page keeps the 0 of a 20 km share (RP-74)", async ({ person, browser, baseURL, db }) => {
    const stamp = Date.now();
    const id = await seedGoal(db, person.id, `Correr ${stamp}`, "kilómetros", 20);
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
      await expect(page.locator("main")).toContainText(/octubre\s*0\s*de\s*0\s*kilómetros/i);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });
});
