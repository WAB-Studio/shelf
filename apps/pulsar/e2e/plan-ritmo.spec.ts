import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";

// RP-50, RP-53: `/metas/<id>/plan` asks a goal with tasks and no rhythm for
// one, then names the plan's end. Every goal is seeded under this spec's own
// identity and deleted by id in `finally`.

const today = todayInZone();
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;
const monthFormat = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });
// Five tasks of 4 h: 20 h, so 12 h a month ends next month and 20 h this one.
const spokenMonth = (month: string) => `${monthFormat.format(new Date(`${month}T12:00:00Z`))} de ${month.slice(0, 4)}`;
const THIS_MONTH = spokenMonth(monthOf(today));
const NEXT_MONTH = spokenMonth(nextMonth(monthOf(today)));

// A white bordered card: 1px line, radius 10 (`Row card`), never `Panel bordered`.
async function expectCard(row: Locator) {
  const box = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(box).toEqual({ border: "1px", radius: "10px" });
}

// Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
async function seedGoal(db: postgres.Sql, personId: string, rhythm: number | null) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta ritmo ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm}, ${`${monthOf(today)}T00:00:00-05:00`}::timestamptz)
    returning id
  `;
  for (let index = 1; index <= 5; index++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${`Tarea ${index}`}, 240, ${index}, true)
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

const LEAD = /^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}, \d+ días? antes de tu final\.$/u;

function planned(page: Page) {
  return page.getByText(LEAD);
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a goal with tasks and no rhythm draws the state: intro, chips, button, tasks without a month", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, null);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByRole("heading", { level: 1, name: "El plan" })).toBeVisible();
        await expect(
          page.getByText("Dile al plan cuántas horas al mes le das a esta meta, y él pone cada tarea en su mes."),
        ).toBeVisible();
        await expect(page.getByText("Horas al mes", { exact: true })).toBeVisible();
        for (const chip of ["8 h", "12 h", "20 h"]) {
          await expect(page.getByRole("radio", { name: chip })).toBeVisible();
        }
        await expect(page.getByPlaceholder("otra")).toBeVisible();
        await expect(page.getByRole("button", { name: "Armar el plan" })).toBeVisible();
        await expect(page.getByText("tareas, sin mes todavía")).toBeVisible();
        await expect(page.getByText("5 · 20 h")).toBeVisible();
        await expect(page.getByText("Tarea 3", { exact: true })).toBeVisible();
        await expect(page.getByText("Tarea 4", { exact: true })).toHaveCount(0);
        await expect(
          page.getByText("Y 2 más. Una tarea sin estimación cuenta como 0 h hasta que le pongas una."),
        ).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("choosing a chip rewrites the hint from the plan filled at that rhythm", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, null);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(
          page.getByText(`Con 12 h al mes, tus 20 h de tareas terminan en ${NEXT_MONTH}. Puedes cambiar un mes puntual después.`),
        ).toBeVisible();
        await page.getByRole("radio", { name: "20 h" }).click();
        await expect(page.getByRole("radio", { name: "20 h" })).toHaveAttribute("aria-checked", "true");
        await expect(page.getByText(new RegExp(`^Con 20 h al mes, tus 20 h de tareas terminan en ${THIS_MONTH}\\.`))).toBeVisible();
        await expect(page.getByText(/^Con 12 h al mes/)).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the hint counts a split task once and names the year", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, null);
      await db`update goals.one_offs set estimate = 270 where goal_id = ${goalId} and name in ('Tarea 1', 'Tarea 2', 'Tarea 3')`;
      await db`delete from goals.one_offs where goal_id = ${goalId} and name in ('Tarea 4', 'Tarea 5')`;
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByPlaceholder("otra").fill("1");
        let end = monthOf(today);
        for (let i = 0; i < 13; i++) end = nextMonth(end);
        const spoken = spokenMonth(end);
        await expect(page.getByText(`Con 1 h al mes, tus 13 h 30 min de tareas terminan en ${spoken}.`, { exact: false })).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a task with no estimate reads «sin estimar» in the list of tasks without a month", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, null);
      await db`update goals.one_offs set estimate = null where goal_id = ${goalId} and name = 'Tarea 1'`;
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByText("sin estimar", { exact: true })).toHaveCount(1);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Armar el plan» saves the rhythm and the lead names the end", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, null);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Armar el plan" }).click();
        await expect(planned(page)).toBeVisible();
        await expect(page.getByText("Ritmo 12 h al mes")).toBeVisible();
        await expect(page.getByRole("button", { name: "Armar el plan" })).toHaveCount(0);
        expect(await rhythmOf(db, goalId)).toBe(720);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the first rhythm raises no «se movió» notice on Hoy, the plan starts there", async ({ page, db, personId }) => {
      const [old] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${personId}, ${`Meta primer ritmo ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', null, now() - interval '70 days')
        returning id
      `;
      const goalId = old.id;
      const closed = `${monthOf(today).slice(0, 7)}-01`;
      const lastMonth = new Date(`${closed}T12:00:00Z`);
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      const lastDay = lastMonth.toISOString().slice(0, 10);
      const [done] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
        values (${personId}, ${goalId}, 'Hecha el mes pasado', 60, 0, true) returning id
      `;
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goalId}, ${done.id}, ${lastDay}::date)`;
      for (let index = 1; index <= 5; index++) {
        await db`
          insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
          values (${personId}, ${goalId}, ${`Tarea ${index}`}, 240, ${index}, true)
        `;
      }
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Armar el plan" }).click();
        await expect(page.getByText("Ritmo 12 h al mes")).toBeVisible();
        const [row] = await db<{ seen: string | null }[]>`select plan_seen::text as seen from goals.goals where id = ${goalId}`;
        expect(row.seen).toBe(lastDay.slice(0, 7) + "-01");
        await page.goto("/");
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.getByText(/se movió \d+/).locator("visible=true")).toHaveCount(0);
      } finally {
        await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
        await drop(db, personId, goalId);
      }
    });

    test("«Cambiar» opens the sheet and a new rhythm changes the end", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 720);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        const before = await planned(page).innerText();
        const row = page.getByRole("button", { name: "Ritmo 12 h al mes" });
        await expectCard(row);
        await expect(row.getByText("Cambiar", { exact: true })).toBeVisible();
        await row.click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: "¿Cuántas horas al mes?" })).toBeVisible();
        await expect(sheet.getByRole("radio", { name: "12 h" })).toHaveAttribute("aria-checked", "true");
        await sheet.getByRole("radio", { name: "20 h" }).click();
        await sheet.getByRole("button", { name: "Guardar el ritmo" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByText("Ritmo 20 h al mes")).toBeVisible();
        await expect(planned(page)).not.toHaveText(before);
        expect(await rhythmOf(db, goalId)).toBe(1200);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    // Every month the sheet's preview names carries its year, this year's too.
    test("the sheet's on-time preview names the year of the end", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 720);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("radio", { name: "20 h" }).click();
        const month = monthOf(today);
        const name = monthFormat.format(new Date(`${month}T12:00:00Z`));
        await expect(
          sheet.getByText(new RegExp(`^Con 20 h al mes terminas el \\d{1,2} de ${name} de ${month.slice(0, 4)}, a tiempo\\.`)),
        ).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the sheet's late preview names the year of the end", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 720);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
        const sheet = page.getByRole("dialog");
        // 20 h at 1 h a month ends 19 months out, past a horizon a year away.
        await sheet.getByPlaceholder("otra").fill("1");
        let end = monthOf(today);
        for (let i = 0; i < 19; i++) end = nextMonth(end);
        const name = monthFormat.format(new Date(`${end}T12:00:00Z`));
        await expect(
          sheet.getByText(
            new RegExp(`^Con 1 h al mes terminas el \\d{1,2} de ${name} de ${end.slice(0, 4)}, \\d+ semanas después de tu final\\.`),
          ),
        ).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the selected chip is a soft fill, not the solid of the primary button", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, null);
      try {
        await visit(page, `/metas/${goalId}/plan`);
        const paint = (selector: ReturnType<Page["locator"]>) =>
          selector.evaluate((el) => {
            const style = getComputedStyle(el);
            return { background: style.backgroundColor, border: style.borderTopColor, color: style.color };
          });
        const selected = await paint(page.getByRole("radio", { name: "12 h" }));
        const other = await paint(page.getByRole("radio", { name: "8 h" }));
        const solid = await paint(page.getByRole("button", { name: "Armar el plan" }));
        expect(selected.background).not.toBe(solid.background);
        expect(selected.background).not.toBe(other.background);
        expect(selected.border).not.toBe(other.border);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the way to the month record lands on /meses", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 720);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        const link = page.getByRole("link", { name: "Ver mes por mes" });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses$`));
      } finally {
        await drop(db, personId, goalId);
      }
    });

    if (width === 1440) {
      test("the column is 640 wide at 1440", async ({ page, db, personId }) => {
        const goalId = await seedGoal(db, personId, 720);
        try {
          await visit(page, `/metas/${goalId}/plan`);
          const box = await planned(page).boundingBox();
          expect(box).not.toBeNull();
          expect(Math.abs(box!.width - 640)).toBeLessThanOrEqual(1);
        } finally {
          await drop(db, personId, goalId);
        }
      });
    }
  });
}
