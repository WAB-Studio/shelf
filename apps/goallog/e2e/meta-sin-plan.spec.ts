import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import roadmap from "../messages/es/roadmap.json";
import { test, expect } from "./fixtures";

// RP-62, `MetaSinPlan` / `MetaSinPlanTareas`: a goal that does not measure
// time has no «El plan» section and no rhythm form; its tasks live in the
// month they are pinned to. Each goal is seeded under this spec's own
// identity and deleted by id in `finally`.

const today = todayInZone();
const monthStart = monthOf(today);
const horizon = (() => {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + 80);
  return dateToCivilDate(date);
})();

const monthName = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(
  new Date(`${monthStart}T12:00:00Z`),
);
const PLAN_LABEL = new RegExp(`^${roadmap.meta.planLabel}$`, "i");
const BUILD = roadmap.meta.build;
const HOURS_PER_MONTH = roadmap.sinRitmo.hoursPerMonth;

async function seedGoal(
  db: postgres.Sql,
  personId: string,
  input: { unit: string | null; tasks: number; budget: number | null },
) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${`Meta sin plan ${Date.now()}`}, ${horizon}::date, ${input.unit}, ${input.unit},
            now() - interval '5 days')
    returning id
  `;
  for (let index = 1; index <= input.tasks; index++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
      values (${personId}, ${goal.id}, ${`Tarea ${index}`}, ${input.unit === "minutos" ? 240 : null}, ${index}, true,
              ${input.unit === "minutos" ? null : monthStart}::date)
    `;
  }
  if (input.budget !== null) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${personId}, ${goal.id}, ${monthStart}::date, ${input.budget})
    `;
  }
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

const planLink = (page: Page) => page.locator('a[href$="/plan"]');

for (const width of [360, 390, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a km goal with tasks has no «El plan» section, keeps its month and «Ver por mes», and does not overflow", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 3, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("link", { name: "Ver por mes", exact: true }).locator("visible=true")).toBeVisible();
        await expect(page.getByText(/de 40/).locator("visible=true").first()).toBeVisible();
        await expect(page.getByText(PLAN_LABEL)).toHaveCount(0);
        await expect(page.getByText(BUILD)).toHaveCount(0);
        await expect(planLink(page)).toHaveCount(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Ver por mes» of a km goal leads to a month that lists its pinned tasks", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 3, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}`);
        await page.getByRole("link", { name: "Ver por mes", exact: true }).locator("visible=true").click();
        await expect(page).toHaveURL(/\/meses$/);
        await page.getByRole("link", { name: new RegExp(monthName, "i") }).locator("visible=true").first().click();
        await expect(page.getByText("Tarea 1").locator("visible=true").first()).toBeVisible();
        await expect(page.getByText("Tarea 3").locator("visible=true").first()).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("/metas/<km goal>/plan never shows the rhythm form: it lands on the goal", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 3, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page).toHaveURL(new RegExp(`/metas/${goalId}$`));
        await expect(page.getByText(HOURS_PER_MONTH, { exact: true })).toHaveCount(0);
        await expect(page.getByText(/cuántas horas al mes/i)).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("El plan");
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a minutes goal with tasks keeps «El plan» and its way in", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: "minutos", tasks: 5, budget: null });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText(PLAN_LABEL).locator("visible=true")).toBeVisible();
        await expect(page.getByText(BUILD).locator("visible=true").first()).toBeVisible();
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/plan$`));
        await expect(page.getByText(HOURS_PER_MONTH, { exact: true })).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a km goal with no tasks has no «El plan» section either", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 0, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByText(PLAN_LABEL)).toHaveCount(0);
        await expect(planLink(page)).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a goal with no measure draws no «El plan» section", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: null, tasks: 0, budget: null });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByText(PLAN_LABEL)).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });
  });
}

// RP-69, `MetaKmTareas`: the month block of a goal measured in something
// other than time says how many of the month's tasks are done. The line sits
// in the block, after «llevas … · faltan …» and before «Ver por mes».
const lastMonth = (() => {
  const date = civilDateToDate(monthStart);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return dateToCivilDate(date);
})();

// Whole-paragraph match: «El plan» of a time goal says «en octubre, 0 de 5 …»,
// which this never matches.
const tasksLine = (page: Page, done: number, total: number) =>
  page
    .getByText(new RegExp(`^${done} de ${total} ${total === 1 ? "tarea hecha" : "tareas hechas"}$`))
    .locator("visible=true");
const anyTasksLine = (page: Page) => page.getByText(/^\d+ de \d+ tareas? hechas?$/).locator("visible=true");

async function pinned(
  db: postgres.Sql,
  personId: string,
  goalId: string,
  name: string,
  month: string,
  position: number,
) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, position, in_plan, planned_month)
    values (${personId}, ${goalId}, ${name}, ${position}, true, ${month}::date) returning id
  `;
  return row.id;
}

async function markDone(db: postgres.Sql, personId: string, goalId: string, oneOffId: string) {
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${personId}, ${goalId}, ${oneOffId}, ${today})
  `;
}

for (const width of [360, 390, 1440]) {
  test.describe(`RP-69 at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a km goal with 2 tasks pinned to this month says «0 de 2 tareas hechas», right after the progress line and before «Ver por mes»", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 2, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}`);
        const line = tasksLine(page, 0, 2);
        await expect(line).toBeVisible();
        await expect(line).toHaveCount(1);
        // The progress line is replaced by the pace line from the 20th on.
        const before = page.getByText(/^llevas \d+ %/).locator("visible=true");
        const anchor = (await before.count()) > 0 ? before.first() : page.getByText(/de 40/).locator("visible=true").first();
        const after = page.getByRole("link", { name: "Ver por mes", exact: true }).locator("visible=true");
        const [a, l, z] = await Promise.all([
          anchor.elementHandle(),
          line.elementHandle(),
          after.elementHandle(),
        ]);
        const order = await page.evaluate(
          ([x, y, w]) => ({
            lineAfterAnchor: Boolean(x!.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING),
            lineBeforeLink: Boolean(y!.compareDocumentPosition(w!) & Node.DOCUMENT_POSITION_FOLLOWING),
          }),
          [a, l, z],
        );
        expect(order.lineAfterAnchor, "the line follows the progress line").toBe(true);
        expect(order.lineBeforeLink, "the line precedes «Ver por mes»").toBe(true);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("marking one of the 2 tasks from the month makes the goal say «1 de 2 tareas hechas»", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 2, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}/meses/${monthStart.slice(0, 7)}`);
        await page.getByRole("button", { name: "Marcar como hecho: Tarea 1" }).locator("visible=true").click();
        await expect(page.getByRole("button", { name: "Marcar como hecho: Tarea 1" })).toHaveCount(0);
        await page.goto(`/metas/${goalId}`);
        await expect(tasksLine(page, 1, 2)).toBeVisible();
        await expect(anyTasksLine(page)).toHaveCount(1);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a parent with 1 of its 2 sub-tasks done counts as not done, and one task reads «tarea hecha» in the singular", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 0, budget: 40 });
      try {
        const parent = await pinned(db, personId, goalId, "Madre", monthStart, 1);
        const [first] = await db<{ id: string }[]>`
          insert into goals.one_offs (user_id, goal_id, parent_id, name, position)
          values (${personId}, ${goalId}, ${parent}, 'Hija 1', 1) returning id`;
        await db`
          insert into goals.one_offs (user_id, goal_id, parent_id, name, position)
          values (${personId}, ${goalId}, ${parent}, 'Hija 2', 2)`;
        await markDone(db, personId, goalId, first.id);
        await page.goto(`/metas/${goalId}`);
        await expect(tasksLine(page, 0, 1)).toBeVisible();
        await expect(anyTasksLine(page)).toHaveCount(1);
        // The mother's sub-tasks are not counted as tasks of their own.
        await expect(page.getByText("1 de 2 tareas hechas")).toHaveCount(0);
        await expect(page.getByText("2 de 2 tareas hechas")).toHaveCount(0);
      } finally {
        await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
        await drop(db, personId, goalId);
      }
    });

    test("a task pinned to last month and not done counts in this month's total", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 1, budget: 40 });
      try {
        await pinned(db, personId, goalId, "Arrastrada", lastMonth, 2);
        await page.goto(`/metas/${goalId}/meses/${monthStart.slice(0, 7)}`);
        await expect(page.getByText("Arrastrada").locator("visible=true").first()).toBeVisible();
        await page.goto(`/metas/${goalId}`);
        await expect(tasksLine(page, 0, 2)).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a km goal with no task in the month says no «tareas hechas» and keeps «Ver por mes»", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 0, budget: 40 });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText(/de 40/).locator("visible=true").first()).toBeVisible();
        await expect(page.getByText(/tareas? hechas?/)).toHaveCount(0);
        await expect(page.getByText(/^0 de 0/)).toHaveCount(0);
        await expect(
          page.getByRole("link", { name: "Ver por mes", exact: true }).locator("visible=true"),
        ).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a minutes goal with tasks keeps «El plan» and draws no tasks line in its month block", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "minutos", tasks: 5, budget: 240 });
      // Pinned to the month, so a line that wrongly drew would have items to count.
      await db`update goals.one_offs set planned_month = ${monthStart}::date where goal_id = ${goalId} and user_id = ${personId}`;
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText(PLAN_LABEL).locator("visible=true")).toBeVisible();
        await expect(anyTasksLine(page)).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a goal with no measure keeps «N tareas · M hechas» once and no tasks line", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, { unit: null, tasks: 2, budget: null });
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(page.getByText("2 tareas · 0 hechas").locator("visible=true")).toHaveCount(1);
        await expect(anyTasksLine(page)).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("an archived km goal still reads its tasks line, and the screen does not overflow", async ({
      page,
      db,
      personId,
    }) => {
      const goalId = await seedGoal(db, personId, { unit: "km", tasks: 2, budget: 40 });
      await db`update goals.goals set archived_at = now() where id = ${goalId}`;
      try {
        await page.goto(`/metas/${goalId}`);
        await expect(tasksLine(page, 0, 2)).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });
  });
}

test.describe("RP-69 look", () => {
  test.use({ viewport: { width: 390, height: 900 } });

  test("the tasks line is 15 px plain text, no card", async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, { unit: "km", tasks: 2, budget: 40 });
    try {
      await page.goto(`/metas/${goalId}`);
      const line = tasksLine(page, 0, 2);
      await expect(line).toBeVisible();
      const style = await line.evaluate((node) => {
        const css = getComputedStyle(node);
        return {
          fontSize: css.fontSize,
          background: css.backgroundColor,
          border: css.borderTopWidth,
          shadow: css.boxShadow,
        };
      });
      expect(style.fontSize).toBe("15px");
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBe("0px");
      expect(style.shadow).toBe("none");
    } finally {
      await drop(db, personId, goalId);
    }
  });
});
