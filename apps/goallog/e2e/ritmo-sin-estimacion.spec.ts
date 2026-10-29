import type postgres from "postgres";

import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// RP-50: no notice of the rhythm names an end when no pending task has an
// estimate. Every goal is seeded under this spec's own identity and deleted by
// id in `finally`.

const today = todayInZone();
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;
const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });
const spokenMonth = (month: string) => `${monthFormat.format(new Date(`${month}T12:00:00Z`))} de ${month.slice(0, 4)}`;
const THIS_MONTH = spokenMonth(monthOf(today));

// Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
async function seedGoal(db: postgres.Sql, personId: string, rhythm: number | null, estimates: (number | null)[]) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta sin estimar ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm}, ${`${monthOf(today)}T00:00:00-05:00`}::timestamptz)
    returning id
  `;
  for (const [index, estimate] of estimates.entries()) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${`Tarea ${index + 1}`}, ${estimate}, ${index + 1}, true)
    `;
  }
  return goal.id;
}

async function rhythmOf(db: postgres.Sql, goalId: string): Promise<number | null> {
  const [row] = await db<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${goalId}`;
  return row.rhythm;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test.describe("the rhythm's notices without an estimate", () => {
  test.use({ viewport: { width: 390, height: 900 } });

  test("first rhythm, no task estimated: the notice names the month the tasks wait in, not an end", async ({
    page,
    db,
    personId,
  }) => {
    const goalId = await seedGoal(db, personId, null, [null, null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("radio", { name: "8 h" }).click();
      await expect(
        page.getByText(
          `Con 8 h al mes. Ninguna tarea tiene estimación todavía: van a ${THIS_MONTH} hasta que les pongas una.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText(/terminan en/)).toHaveCount(0);
      await expect(page.getByText(/terminas el/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("the sheet, no pending task estimated: the notice names the month, not an end", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, 720, [null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
      const sheet = page.getByRole("dialog");
      await expect(
        sheet.getByText(
          `Con 12 h al mes. Ninguna tarea pendiente tiene estimación: van a ${THIS_MONTH} hasta que les pongas una. Los meses que ya cerraron no cambian.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(sheet.getByText(/terminas el/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("the lead of the plan, no pending task estimated: no «terminas el»", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, 720, [null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await expect(
        page.getByText(`Ninguna tarea pendiente tiene estimación: van a ${THIS_MONTH} hasta que les pongas una.`, { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/terminas el/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("the lead keeps «terminas el» when one pending task has an estimate", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, 720, [180, null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await expect(page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}/u)).toBeVisible();
      await expect(page.getByText(/Ninguna tarea pendiente tiene estimación/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("one task of 3 h and two without: the first rhythm keeps «tus 3 h de tareas terminan en»", async ({
    page,
    db,
    personId,
  }) => {
    const goalId = await seedGoal(db, personId, null, [180, null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await expect(page.getByText(/^Con 12 h al mes, tus 3 h de tareas terminan en \p{L}+ de \d{4}\./u)).toBeVisible();
      await expect(page.getByText(/Ninguna tarea tiene estimación todavía/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("all estimated: the sheet keeps its on-time sentence", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, 720, [240, 240, 240, 240, 240]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("radio", { name: "20 h" }).click();
      await expect(sheet.getByText(/^Con 20 h al mes terminas el \d{1,2} de \p{L}+ de \d{4}, a tiempo\./u)).toBeVisible();
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("«Armar el plan» still saves the rhythm with no task estimated", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, null, [null, null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("radio", { name: "8 h" }).click();
      const build = page.getByRole("button", { name: "Armar el plan" });
      await expect(build).toBeEnabled();
      await build.click();
      await expect(page.getByText("Ritmo 8 h al mes")).toBeVisible();
      expect(await rhythmOf(db, goalId)).toBe(480);
    } finally {
      await drop(db, personId, goalId);
    }
  });

  test("text that reads as nothing draws no preview sentence", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, null, [null, null, null]);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByPlaceholder("otra").fill("8 hss");
      await expect(page.getByText(/^Con .* al mes/)).toHaveCount(0);
    } finally {
      await drop(db, personId, goalId);
    }
  });
});
