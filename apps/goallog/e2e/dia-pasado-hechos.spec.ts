import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// `DiaPasado.dc.html`, `DiaPasadoPasos.dc.html`: a past day's goal heading
// counts what «hechos» counts (docs/goallog/DESIGN.md, «A past day's heading
// counts what "hechos" counts»), the tally is a sentence whose figures are
// mono, and «este mes» on the phone stands its groups one gap apart.

const WORDS = ["ninguno", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

async function seedGoal(db: postgres.Sql, personId: string, name: string) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${plusDays(60)}::date, now() - interval '40 days') returning id
  `;
  return goal.id;
}

async function seedRow(
  db: postgres.Sql,
  personId: string,
  goalId: string,
  row: { name: string; kind?: "daily" | "times_per_week"; target?: number; done: string[]; quantity?: number },
) {
  const kind = row.kind ?? "daily";
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit, created_at)
    values (
      ${personId}, ${goalId}, ${row.name}, ${kind}, ${kind === "daily" ? null : 2},
      ${row.target ? "quantity" : "tap"}, ${row.target ?? null}, ${row.target ? "min" : null},
      now() - interval '40 days'
    ) returning id
  `;
  for (const day of row.done) {
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${personId}, ${goalId}, ${commitment.id}, ${day}::date, ${row.quantity ?? null})
    `;
  }
}

test("a past day with five daily rows (three done, one partial) and a weekly row reads «ese día pedía seis» and «hechos 3 de 9 · 1 en parte»; the headings sum to the tally on three days (RP-44, RP-01)", async ({
  browser,
  db,
  person,
}) => {
  const stamp = Date.now();
  const days = [plusDays(-1), plusDays(-2), plusDays(-3)];
  const mainName = `Cinco ${stamp}`;
  const otherName = `Dos ${stamp}`;
  const main = await seedGoal(db, person.id, mainName);
  const other = await seedGoal(db, person.id, otherName);
  // The exact counts are asserted over the whole page, so the person is the worker's own.
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    // Daily rows 1-3 done, 4 partial (quantity), 5 untouched; one weekly row, done only on the earliest
    // day so it asks on all three whatever week they fall in (RP-01).
    for (let i = 1; i <= 3; i += 1) await seedRow(db, person.id, main, { name: `Hecha ${i} ${stamp}`, done: days });
    await seedRow(db, person.id, main, { name: `Parte ${stamp}`, target: 10, done: days, quantity: 4 });
    await seedRow(db, person.id, main, { name: `Vacía ${stamp}`, done: [] });
    await seedRow(db, person.id, main, { name: `Semanal ${stamp}`, kind: "times_per_week", done: [days[2]] });
    // A second goal: two daily rows and a weekly one, none done.
    await seedRow(db, person.id, other, { name: `Otra A ${stamp}`, done: [] });
    await seedRow(db, person.id, other, { name: `Otra B ${stamp}`, done: [] });
    await seedRow(db, person.id, other, { name: `Otra S ${stamp}`, kind: "times_per_week", done: [] });
    for (const day of days) {
      await page.goto(`/dia/${day}`);
      const tally = page.getByText(/^hechos \d+ de \d+( · \d+ en parte)?$/);
      await expect(tally).toBeVisible();
      const total = Number((await tally.textContent())!.match(/^hechos \d+ de (\d+)/)![1]);
      const headings = await page.getByText(/ese día pedía \w+$/).allTextContents();
      expect(headings).toHaveLength(2);
      const summed = headings.reduce((sum, text) => sum + WORDS.indexOf(text.split("pedía ")[1]), 0);
      expect(summed).toBe(total);
      expect(total).toBe(9);
    }

    await page.goto(`/dia/${days[0]}`);
    await expect(page.getByText(`${mainName} · ese día pedía seis`)).toHaveCount(1);
    await expect(page.getByText(`${otherName} · ese día pedía tres`)).toHaveCount(1);
    await expect(page.getByText(/^hechos 3 de 9 · 1 en parte$/)).toBeVisible();

    // The tally is a sentence: its line and its figures are Archivo.
    const line = page.getByText(/^hechos 3 de 9 · 1 en parte$/);
    const fonts = await line.evaluate((el) => ({
      line: getComputedStyle(el).fontFamily,
      figures: [...el.querySelectorAll("span")].map((span) => getComputedStyle(span).fontFamily),
    }));
    expect(fonts.line).not.toMatch(/mono/i);
    expect(fonts.line).toMatch(/archivo/i);
    expect(fonts.figures).toHaveLength(3);
    for (const family of fonts.figures) expect(family).not.toMatch(/mono/i);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = any(${[main, other]}) and user_id = ${person.id}`;
  }
});

test("a goal whose rows that day are all weekly still says what that day asked: «pedía uno» (RP-44, RP-01)", async ({ person, browser, db }) => {
  const stamp = Date.now();
  const name = `Solo semanal ${stamp}`;
  const goal = await seedGoal(db, person.id, name);
  // The absence is asserted over the whole page, so the person is the worker's own.
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    await seedRow(db, person.id, goal, { name: `Semanal ${stamp}`, kind: "times_per_week", done: [] });
    const page = await context.newPage();
    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.getByText(`${name} · ese día pedía uno`)).toHaveCount(1);
    await expect(page.getByText("hechos 0 de 1", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal} and user_id = ${person.id}`;
  }
});

test("at 390 the «este mes» groups on Hoy stand one gap apart (RP-28)", async ({ page, db, personId }) => {
  const stamp = Date.now();
  const monthStart = `${todayInZone().slice(0, 7)}-01`;
  const names = [`Medida ${stamp}`, `Con tarea ${stamp}`, `Sin medida ${stamp}`];
  const ids: string[] = [];
  try {
    for (const [index, name] of names.entries()) {
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
        values (${personId}, ${name}, ${plusDays(90)}::date,
          ${index < 2 ? "minutos" : null}, ${index < 2 ? "minutos" : null}, now() - interval '40 days')
        returning id
      `;
      ids.push(goal.id);
      if (index < 2) {
        await db`
          insert into goals.month_budgets (user_id, goal_id, month, amount)
          values (${personId}, ${goal.id}, ${monthStart}::date, 300)
        `;
      }
      if (index > 0) {
        await db`
          insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, position)
          values (${personId}, ${goal.id}, ${`Tarea ${index} ${stamp}`}, ${monthStart}::date, ${index === 1 ? 20 : null}, 1)
        `;
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const boxes: { y: number; height: number }[] = [];
    for (const name of names) {
      const heading = page.getByText(name, { exact: true }).locator("visible=true").last();
      await expect(heading).toBeVisible();
      boxes.push((await boxOf(heading.locator("xpath=.."))));
    }
    const gaps = boxes.slice(1).map((box, i) => box.y - (boxes[i].y + boxes[i].height));
    expect(gaps.length).toBe(2);
    expect(Math.abs(gaps[0] - gaps[1])).toBeLessThanOrEqual(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(24);
  } finally {
    await db`delete from goals.goals where id = any(${ids}) and user_id = ${personId}`;
  }
});
