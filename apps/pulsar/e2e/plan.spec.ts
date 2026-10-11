import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import roadmap from "../messages/es/roadmap.json";

import { test, expect } from "./fixtures";

// RP-50, RP-53, RP-54: the plan's month sections, its tramo medio, the end
// against the goal's end, and «Añadir una tarea». Calendar-bound: «this month»
// is the current one. Every goal is seeded under this spec's own identity and
// deleted by id in `finally`.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const today = todayInZone();
const thisYear = today.slice(0, 4);
const m0 = monthOf(today);
const m1 = nextMonth(m0);
const m2 = nextMonth(m1);
const m3 = nextMonth(m2);
const m4 = nextMonth(m3);
// The plan's own wording: the year shows only off this year.
const name = (month: string) =>
  month.slice(0, 4) === thisYear ? NAMES[Number(month.slice(5, 7)) - 1] : `${NAMES[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;

// The catalogue's sentence with its `{name}` slots filled.
const say = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template.replace(/<\/?fig>/g, ""));

// A white bordered card: 1px line, radius 10 (`Row card`), never `Panel bordered`.
async function expectCard(row: Locator) {
  const box = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  expect(box).toEqual({ border: "1px", radius: "10px" });
}

type Db = postgres.Sql;

async function seedGoal(db: Db, personId: string, rhythm: number | null, horizon: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
    values (${personId}, ${`Meta plan ${Date.now()}`}, ${horizon}::date, 'minutos', 'minutos', ${rhythm})
    returning id
  `;
  return goal.id;
}

async function seedTasks(db: Db, personId: string, goalId: string, tasks: ([string, number] | [string, number, string])[]) {
  let position = 0;
  for (const [taskName, estimate, fixed] of tasks) {
    position += 1;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, planned_month)
      values (${personId}, ${goalId}, ${taskName}, ${estimate}, ${position}, true, ${fixed ?? null}::date)
    `;
  }
}

async function drop(db: Db, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

// A section of the page: the label's text up to the next one.
const section = (page: Page, label: string) => page.locator("section").filter({ has: page.getByText(label, { exact: true }) });

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a task split over two months reads «Empieza aquí con 3 h» / «3 de 8 h» and «Viene de»  / «5 de 8 h»", async ({ page, db, personId }) => {
      // 8 h a month: 5 h task, then an 8 h task that takes 3 h here and 5 h on.
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Primera", 300], ["Repartida", 480]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        const first = section(page, `${name(m0)} · en curso`);
        await expect.soft(first.getByText(`Empieza aquí con 3 h y sigue en ${name(m1)}.`)).toBeVisible();
        await expect.soft(first.getByText("3 de 8 h", { exact: true })).toBeVisible();
        const second = section(page, name(m1));
        await expect.soft(second.getByText(`Viene de ${name(m0)}.`)).toBeVisible();
        await expect.soft(second.getByText("5 de 8 h", { exact: true })).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("the middle month of a task over three reads «Viene de» and «sigue en», with its part of the total", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 720, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Corta", 300], ["Larga", 1800]]);
      try {
        await page.goto(`/metas/${goalId}/plan?todo=1`);
        const first = section(page, `${name(m0)} · en curso`);
        await expect.soft(first.getByText(`Empieza aquí con 7 h y sigue en ${name(m1)}.`)).toBeVisible();
        await expect.soft(first.getByText("7 de 30 h", { exact: true })).toBeVisible();
        await expect.soft(first.getByText("0 de 2 tareas hechas", { exact: true })).toBeVisible();
        const middle = section(page, name(m1));
        await expect.soft(middle.getByText(`Viene de ${name(m0)} y sigue en ${name(m2)}.`)).toBeVisible();
        await expect.soft(middle.getByText("12 de 30 h", { exact: true })).toBeVisible();
        await expect.soft(middle.getByText(say(roadmap.plan.monthPlanned, { filled: "12 h", amount: "12 h" }), { exact: true })).toBeVisible();
        const last = section(page, name(m2));
        await expect.soft(last.getByText(`Viene de ${name(m1)}.`, { exact: true })).toBeVisible();
        await expect.soft(last.getByText("11 de 30 h", { exact: true })).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a month's progress bar is 6 px tall", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Una", 60]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        const bar = section(page, `${name(m0)} · en curso`).locator("span[aria-hidden]").first();
        await expect(bar).toBeVisible();
        expect((await bar.boundingBox())!.height).toBe(6);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a fixed task carries its pin; a free one does not", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Examen", 60, m0], ["Suelta", 60]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByText(`Fijada en ${name(m0)}`)).toHaveCount(1);
        await expect(page.getByRole("button", { name: /^Examen/ }).getByText(`Fijada en ${name(m0)}`)).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("far months collapse into one section and «Ver el resto del plan» opens them", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["T1", 480], ["T2", 480], ["T3", 480], ["T4", 480], ["T5", 480]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(section(page, `${name(m0)} · en curso`).getByText("T1", { exact: true })).toBeVisible();
        await expect(section(page, name(m1)).getByText("T2", { exact: true })).toBeVisible();
        const rest = section(page, `${name(m2)} a ${name(m4)}`);
        await expect(rest.getByText("3 tareas · 24 h", { exact: true })).toBeVisible();
        await expect(page.getByText("T3", { exact: true })).toHaveCount(0);
        await expectCard(page.getByRole("link", { name: "Ver el resto del plan" }));
        await page.getByRole("link", { name: "Ver el resto del plan" }).click();
        await expect(page).toHaveURL(/\?todo=1$/);
        for (const task of ["T3", "T4", "T5"]) await expect(page.getByText(task, { exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Ver el resto del plan" })).toHaveCount(0);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Añadir una tarea» opens an empty sheet with no «Borrar», and saving lands the task in the plan", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Existente", 60]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Añadir una tarea" }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: "Una tarea nueva" })).toBeVisible();
        await expect(sheet.getByLabel("Nombre")).toHaveValue("");
        await expect(sheet.getByRole("radio", { name: /Lo pone el plan/ })).toHaveAttribute("aria-checked", "true");
        await expect(sheet.getByRole("button", { name: "Borrar la tarea" })).toHaveCount(0);
        await sheet.getByLabel("Nombre").fill("Tarea añadida");
        await sheet.getByRole("spinbutton").first().fill("2");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByText("Tarea añadida", { exact: true })).toBeVisible();
        const [saved] = await db<{ estimate: number; in_plan: boolean }[]>`
          select estimate, in_plan from goals.one_offs where goal_id = ${goalId} and name = 'Tarea añadida'
        `;
        expect(saved).toEqual({ estimate: 120, in_plan: true });
      } finally {
        await drop(db, personId, goalId);
      }
    });

    // Three months of 8 h, 33 h of tasks: the plan ends in the fifth month.
    async function seedLate() {
      return { horizon: nextMonth(m2), tasks: [["A", 480], ["B", 480], ["C", 480], ["D", 240], ["E", 300]] as [string, number][] };
    }

    // Three months of tasks from this month on: the plan ends soonest, in this year until Q4's last month.
    test("the day the plan ends carries its year even when it falls in the current year", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, m1);
      await seedTasks(db, personId, goalId, [["A", 480], ["B", 480], ["C", 480]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByText(/^Al \d{1,2} de \p{L}+ de \d{4}, donde termina el plan\.$/u)).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a goal past its end shows both offers, the past-end tasks and no danger colour", async ({ page, db, personId }) => {
      const late = await seedLate();
      const goalId = await seedGoal(db, personId, 480, late.horizon);
      await seedTasks(db, personId, goalId, late.tasks);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}, \d+ semanas? después de tu final, el \d{1,2} de \p{L}+ de \d{4}\.$/u)).toBeVisible();
        await expect(page.getByRole("button", { name: "Subir el ritmo" })).toBeVisible();
        await expect(page.getByText("Con 11 h al mes llegas a tiempo.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Mover el final" })).toBeVisible();
        for (const row of ["Subir el ritmo", "Mover el final"]) await expectCard(page.getByRole("button", { name: row }));
        await expect(page.getByText(/^Al \d{1,2} de \p{L}+ de \d{4}, donde termina el plan\.$/u)).toBeVisible();
        expect(await page.getByText(/^Al \d{1,2} de \p{L}+ de \d{4}, donde termina el plan\./u).locator("> span").evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
        await expect(page.getByText("O quita tareas del plan: cada una que sale adelanta el final.")).toBeVisible();
        const past = section(page, "después de tu final");
        await expect(past.getByText("2 tareas · 9 h", { exact: true })).toBeVisible();
        for (const task of ["D", "E"]) await expect(past.getByText(task, { exact: true })).toBeVisible();
        await expect(past.getByText("A", { exact: true })).toHaveCount(0);
        // Every month drawn whole (`?todo=1`): D and E sit once, under «después de tu final», never also in a month.
        await page.goto(`/metas/${goalId}/plan?todo=1`);
        for (const task of ["D", "E"]) await expect(page.getByText(task, { exact: true })).toHaveCount(1);
        await expect(section(page, "después de tu final").getByText("D", { exact: true })).toHaveCount(1);
        // No element paints a red: its red channel never leads green and blue by 60.
        const reds = await page.evaluate(() => {
          const found: string[] = [];
          for (const el of document.querySelectorAll("body *")) {
            const style = getComputedStyle(el);
            for (const value of [style.color, style.backgroundColor, style.borderTopColor, style.borderBottomColor]) {
              const match = value.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
              if (!match || (match[4] !== undefined && Number(match[4]) === 0)) continue;
              const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
              if (r - g >= 60 && r - b >= 60) found.push(`${el.tagName} ${value}`);
            }
          }
          return found;
        });
        expect(reds).toEqual([]);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a task that starts inside the span reads its part in its month; only what falls after the end sits under «después de tu final», and opens its sheet", async ({ page, db, personId }) => {
      // Two months of 8 h, then a 20 h task after a 6 h one: 2 h here, 8 h next, 10 h past the end.
      const goalId = await seedGoal(db, personId, 480, m2);
      await seedTasks(db, personId, goalId, [["Primera", 360], ["Larga", 1200]]);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        const first = section(page, `${name(m0)} · en curso`);
        await expect(first.getByText(`Empieza aquí con 2 h y sigue en ${name(m1)}.`)).toBeVisible();
        const second = section(page, name(m1));
        await expect(second.getByText("Larga", { exact: true })).toBeVisible();
        await expect(second.getByText("8 de 20 h", { exact: true })).toBeVisible();
        const past = section(page, "después de tu final");
        await expect(past.getByText("1 tarea · 10 h", { exact: true })).toBeVisible();
        await past.getByText("Larga", { exact: true }).click();
        await expect(page.getByRole("dialog").getByLabel("Nombre")).toHaveValue("Larga");
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("a task with no estimate reads «sin estimar» as its trailing", async ({ page, db, personId }) => {
      const goalId = await seedGoal(db, personId, 480, `${Number(thisYear) + 1}-${today.slice(5, 7)}-01`);
      await seedTasks(db, personId, goalId, [["Con cálculo", 60]]);
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
        values (${personId}, ${goalId}, 'Sin cálculo', null, 9, true)
      `;
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await expect(page.getByText("sin estimar", { exact: true })).toHaveCount(1);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Subir el ritmo» opens the rhythm sheet prefilled with the rhythm that meets the end", async ({ page, db, personId }) => {
      const late = await seedLate();
      const goalId = await seedGoal(db, personId, 480, late.horizon);
      await seedTasks(db, personId, goalId, late.tasks);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: "Subir el ritmo" }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: "¿Cuántas horas al mes?" })).toBeVisible();
        await expect(sheet.getByText(/^Con 11 h al mes terminas el \d{1,2} de \p{L}+ de \d{4}, a tiempo\./u)).toBeVisible();
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Mover el final» asks first: the sheet names both ends, «Cancelar» writes nothing, «Moverlo» moves the horizon and the offers go", async ({ page, db, personId }) => {
      const late = await seedLate();
      const goalId = await seedGoal(db, personId, 480, late.horizon);
      await seedTasks(db, personId, goalId, late.tasks);
      const horizonOf = async () =>
        (await db<{ horizon: string }[]>`select to_char(horizon, 'YYYY-MM-DD') as horizon from goals.goals where id = ${goalId}`)[0].horizon;
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("heading", { name: roadmap.moverFinal.title })).toBeVisible();
        await expect(sheet).toContainText(/^Mover el finalDel \d{1,2} de \p{L}+ de \d{4} al \d{1,2} de \p{L}+ de \d{4}, donde termina el plan\./u);
        await expect(sheet.getByRole("button", { name: roadmap.moverFinal.move })).toBeEnabled();
        // The two dates are DM Mono; the words around them are not.
        const body = sheet.locator("p").first();
        expect(await body.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
        const dates = body.locator("> span");
        await expect(dates).toHaveCount(2);
        for (let i = 0; i < 2; i++) expect(await dates.nth(i).evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
        expect(await horizonOf()).toBe(late.horizon);
        await sheet.getByRole("button", { name: roadmap.moverFinal.cancel }).click();
        await expect(sheet).toBeHidden();
        expect(await horizonOf()).toBe(late.horizon);

        await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
        await page.getByRole("dialog").getByRole("button", { name: roadmap.moverFinal.move }).click();
        await expect(page.getByRole("dialog")).toBeHidden();
        await expect(page.getByRole("button", { name: roadmap.moverFinal.title })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Subir el ritmo" })).toHaveCount(0);
        await expect(page.getByText("después de tu final", { exact: true })).toHaveCount(0);
        // The end falls on the new last day: no day of slack, none late.
        await expect(page.getByText(/^A este ritmo terminas el \d{1,2} de \p{L}+ de \d{4}, el día de tu final\.$/u)).toBeVisible();
        await expect(page.getByText(/0 días/)).toHaveCount(0);
        expect((await horizonOf()) > late.horizon).toBe(true);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Cancelar» stays enabled and closes the sheet while «Mover el final» is in flight; the held write never lands", async ({ page, db, personId }) => {
      const late = await seedLate();
      const goalId = await seedGoal(db, personId, 480, late.horizon);
      await seedTasks(db, personId, goalId, late.tasks);
      const horizonOf = async () =>
        (await db<{ horizon: string }[]>`select to_char(horizon, 'YYYY-MM-DD') as horizon from goals.goals where id = ${goalId}`)[0].horizon;
      // The server action is held at the network and aborted, never forwarded: nothing is written.
      let held: (() => Promise<void>) | undefined;
      let reached!: () => void;
      const inFlight = new Promise<void>((resolve) => (reached = resolve));
      await page.route("**/metas/**", async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
        held = () => route.abort();
        reached();
      });
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("button", { name: roadmap.moverFinal.move }).click();
        await inFlight;
        await expect(sheet.getByRole("button", { name: roadmap.moverFinal.pending })).toBeDisabled();
        const cancel = sheet.getByRole("button", { name: roadmap.moverFinal.cancel });
        await expect(cancel).toBeEnabled();
        await cancel.click();
        await expect(sheet).toBeHidden();
        await held!();
        expect(await horizonOf()).toBe(late.horizon);
      } finally {
        await drop(db, personId, goalId);
      }
    });

    test("«Mover el final» on a goal deleted under the open sheet keeps the sheet and says it failed", async ({ page, db, personId }) => {
      const late = await seedLate();
      const goalId = await seedGoal(db, personId, 480, late.horizon);
      await seedTasks(db, personId, goalId, late.tasks);
      try {
        await page.goto(`/metas/${goalId}/plan`);
        await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await drop(db, personId, goalId);
        await sheet.getByRole("button", { name: roadmap.moverFinal.move }).click();
        await expect(sheet.getByRole("alert")).toHaveText(roadmap.moverFinal.failed);
        await expect(sheet.getByRole("button", { name: roadmap.moverFinal.move })).toBeEnabled();
        await expect(sheet.getByRole("button", { name: roadmap.moverFinal.cancel })).toBeEnabled();
      } finally {
        await drop(db, personId, goalId);
      }
    });
  });
}

// RP-53, `RoadmapMoverFinalHoja`: the sheet names the goal's last day and the day the plan
// ends, each with its year; a refusal does not outlive the sheet.
test("«Mover el final» names the goal's last day and the plan's end, and a reopened sheet forgets a past failure (RP-53)", async ({ page, db, personId }) => {
  const year = Number(thisYear);
  // The goal ends on 31 Dec of this year; the plan, two months past it.
  const monthsLeft = 12 - Number(today.slice(5, 7)) + 1;
  const tasks = Array.from({ length: monthsLeft + 2 }, (_, i): [string, number] => [`Tarea ${i + 1}`, 480]);
  const goalId = await seedGoal(db, personId, 480, `${year + 1}-01-01`);
  await seedTasks(db, personId, goalId, tasks);
  try {
    await page.goto(`/metas/${goalId}/plan`);
    await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: roadmap.moverFinal.title })).toBeVisible();
    await expect(sheet).toContainText(
      new RegExp(`^Mover el finalDel 31 de diciembre de ${year} al \\d{1,2} de \\p{L}+ de ${year + 1}, donde termina el plan\\.`, "u"),
    );

    await drop(db, personId, goalId);
    await sheet.getByRole("button", { name: roadmap.moverFinal.move }).click();
    await expect(sheet.getByRole("alert")).toHaveText(roadmap.moverFinal.failed);
    await sheet.getByRole("button", { name: roadmap.moverFinal.cancel }).click();
    await expect(sheet).toBeHidden();

    await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: roadmap.moverFinal.title })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});
