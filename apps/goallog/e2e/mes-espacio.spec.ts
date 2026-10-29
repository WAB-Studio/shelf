import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import monthMessages from "../messages/es/month.json";
import { boxOf } from "./box";

const owesLine = (month: string, owes: string) =>
  monthMessages.list.owes.replace(/<\/?fig>/g, "").replace("{month}", month).replace("{owes}", owes);

// `SistemaEspacio.dc.html`, `SistemaTipo.dc.html`: «Mes» and the
// month's forms on the space and type system. The goals of «Mes» stand on one
// edge, sections 32 apart, a mixed line sets its sentence in Archivo and its
// figures in mono, and a refusal reads under its own field.

const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;
const seg = thisMonth.slice(0, 7);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${personId}, ${goal.id}, ${thisMonth}::date, 600)`;
  await db`insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate) values (${personId}, ${goal.id}, ${`Vieja ${name}`}, ${lastMonth}::date, 180)`;
  await db`insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate) values (${personId}, ${goal.id}, ${`Propia ${name}`}, ${thisMonth}::date, 60)`;
  return goal.id;
}

test("«Mes» sets a mixed line's sentence in Archivo and its figure in mono; its sections stand 32 apart", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  await seedGoal(db, person.id, `Espacio ${stamp}`);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mes");
    const line = page.getByText(new RegExp(`^${owesLine(".*", "3 h")}$`));
    await expect(line).toBeVisible();
    const fonts = await line.evaluate((el) => ({
      line: getComputedStyle(el).fontFamily,
      figure: getComputedStyle(el.querySelector("span")!).fontFamily,
      figureText: el.querySelector("span")!.textContent,
    }));
    expect(fonts.figureText).toBe("3 h");
    expect(fonts.line).not.toBe(fonts.figure);
    expect(fonts.figure).toMatch(/mono/i);

    const labels = page.locator("section").getByText(/^de /, { exact: false });
    const carried = page.getByText(`de ${new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(`${lastMonth}T12:00:00Z`))}`, { exact: true });
    const own = page.getByText(/^de .* · 1 h$/);
    await expect(carried).toBeVisible();
    await expect(own).toBeVisible();
    const gap = (await boxOf(own)).y - ((await boxOf(page.getByText(`Vieja Espacio ${stamp}`))).y + (await boxOf(page.getByText(`Vieja Espacio ${stamp}`))).height);
    expect(gap, "carried rows → next section label").toBeGreaterThanOrEqual(32);
    expect(await labels.count()).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

for (const width of [1024, 1440] as const) {
  test(`at ${width} the goal blocks of «Mes» share a left edge with the title and stand 16 apart`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    for (const name of ["A", "B", "C"]) await seedGoal(db, person.id, `${name} bloque ${stamp}`);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/mes");
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3);
      const panels = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2 }) });
      const rects = await panels.evaluateAll((els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect();
          const heading = el.querySelector("h2")!.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, headingLeft: heading.left };
        }),
      );
      expect(rects.length).toBeGreaterThanOrEqual(3);
      const title = (await boxOf(page.getByRole("heading", { level: 1 })));
      expect(rects[0].left, "first block on the title's edge").toBeCloseTo(title.x, 0);
      for (let i = 1; i < rects.length; i += 1) {
        // Side by side or stacked, the cards stand 16 apart and never touch.
        const beside = Math.abs(rects[i].top - rects[i - 1].top) < 1;
        if (beside) expect(rects[i].left - rects[i - 1].right, "cards 16 apart").toBeCloseTo(16, 0);
        else {
          expect(rects[i].left, "stacked on one edge").toBeCloseTo(rects[i - 1].left, 0);
          expect(rects[i].top - rects[i - 1].bottom, "cards 16 apart").toBeCloseTo(16, 0);
        }
      }
      const inset = rects[0].headingLeft - rects[0].left;
      for (const rect of rects) expect(rect.headingLeft - rect.left, "one inset in every block").toBeCloseTo(inset, 0);
    } finally {
      await context.close();
    }
  });
}

test("a task's empty name is refused under its own field, with the ring, one hint-gap below the control", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Forma ${stamp}`);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const width of [360, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goalId}/meses/${seg}/tarea/nueva`);
      await page.getByRole("button", { name: "Guardar la tarea" }).click();
      const field = page.getByLabel("qué hay que hacer");
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const refusal = page.getByText("Escribe qué hay que hacer.");
      await expect(refusal).toBeVisible();
      const control = (await boxOf(field));
      const hint = (await boxOf(refusal));
      expect(hint.y - (control.y + control.height), `hint under its control at ${width}`).toBeLessThanOrEqual(10);
      expect(hint.y).toBeGreaterThan(control.y);
      // One eyebrow, in the one eyebrow style: the goal and the month, not a repeat of the title or the back.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }
  } finally {
    await context.close();
  }
});
