import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// RP-50, RNP-07: a plan with no rhythm draws one solid act,
// «Armar el plan»; «Añadir una tarea» stands outlined beneath it. With a
// rhythm, or with no measure at all, no rhythm form is drawn and «Añadir una
// tarea» is the screen's only button, solid (DESIGN: «the act the screen is
// for», one per screen). Every goal is seeded under the disposable person and
// deleted by id.

const today = todayInZone();
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

async function seedGoal(db: postgres.Sql, personId: string, opts: { rhythm: number | null; measured: boolean }) {
  // Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`Meta un acto ${Date.now()}`}, ${horizon}::date,
      ${opts.measured ? "minutos" : null}, ${opts.measured ? "minutos" : null}, ${opts.rhythm}, date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota')
    returning id
  `;
  for (let index = 1; index <= 3; index++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${`Tarea ${index}`}, ${opts.measured ? 240 : null}, ${index}, true)
    `;
  }
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

// The accent token as the browser resolves it, so no colour is typed here.
async function accentFill(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--pulsar-accent)";
    document.body.append(probe);
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  });
}

async function paint(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true }).evaluate((el) => {
    const style = getComputedStyle(el);
    // The outline draws its ring as an inset shadow, never a border.
    const ring = style.boxShadow.match(/0px 0px 0px ([\d.]+)px/);
    return { fill: style.backgroundColor, border: ring ? `${ring[1]}px` : "0px" };
  });
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("no rhythm: «Armar el plan» is the one accent-filled button on the screen; «Añadir una tarea» is outlined", async ({
      person,
      browser,
      db,
    }) => {
      const goalId = await seedGoal(db, person.id, { rhythm: null, measured: true });
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByRole("button", { name: "Armar el plan" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Añadir una tarea", exact: true })).toBeVisible();

        const accent = await accentFill(page);
        const solids = await page
          .locator("main button")
          .evaluateAll(
            (buttons, fill) =>
              buttons
                .filter((el) => (el as HTMLElement).offsetParent !== null && getComputedStyle(el).backgroundColor === fill)
                .map((el) => el.textContent?.trim()),
            accent,
          );
        expect(solids).toEqual(["Armar el plan"]);

        const add = await paint(page, "Añadir una tarea");
        expect(add.fill).toBe(TRANSPARENT);
        expect(add.border).toBe("1.5px");
      } finally {
        await context.close();
        await drop(db, person.id, goalId);
      }
    });

    test("rhythm set: «Añadir una tarea» is the solid, accent-filled act", async ({ person, browser, db }) => {
      const goalId = await seedGoal(db, person.id, { rhythm: 720, measured: true });
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByRole("button", { name: "Armar el plan" })).toHaveCount(0);
        const accent = await accentFill(page);
        const add = await paint(page, "Añadir una tarea");
        expect(add.fill).toBe(accent);
        expect(add.border).toBe("0px");
      } finally {
        await context.close();
        await drop(db, person.id, goalId);
      }
    });

    test("no measure: no rhythm form is drawn and «Añadir una tarea» is solid", async ({ person, browser, db }) => {
      const goalId = await seedGoal(db, person.id, { rhythm: null, measured: false });
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByRole("heading", { level: 1, name: "El plan" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Armar el plan" })).toHaveCount(0);
        const accent = await accentFill(page);
        const add = await paint(page, "Añadir una tarea");
        expect(add.fill).toBe(accent);
        expect(add.border).toBe("0px");
      } finally {
        await context.close();
        await drop(db, person.id, goalId);
      }
    });

    test("the outlined «Añadir una tarea» still opens the task sheet", async ({ person, browser, db }) => {
      const goalId = await seedGoal(db, person.id, { rhythm: null, measured: true });
      const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        await page.goto(`/metas/${goalId}/plan`);
        // Outlined first: this is the outline branch's own click.
        expect((await paint(page, "Añadir una tarea")).fill).toBe(TRANSPARENT);
        await page.getByRole("button", { name: "Añadir una tarea", exact: true }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: "Una tarea nueva" })).toBeVisible();
        await expect(sheet.getByLabel("Nombre")).toHaveValue("");
      } finally {
        await context.close();
        await drop(db, person.id, goalId);
      }
    });
  });
}

test("at 1440 both buttons are sized to their text, 160 px at least, never the column", async ({ person, browser, db }) => {
  const goalId = await seedGoal(db, person.id, { rhythm: null, measured: true });
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/plan`);
    await expect(page.getByRole("button", { name: "Añadir una tarea", exact: true })).toBeVisible();
    expect((await paint(page, "Añadir una tarea")).fill).toBe(TRANSPARENT);
    for (const name of ["Armar el plan", "Añadir una tarea"]) {
      const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(160);
      expect(box.width).toBeLessThan(400);
    }
  } finally {
    await context.close();
    await drop(db, person.id, goalId);
  }
});
