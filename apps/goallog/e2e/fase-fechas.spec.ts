import type { Locator } from "@playwright/test";

import { addWeeksToCivilDate, civilDateLabel, todayInZone, weekOf } from "@/lib/zone";
import { dayBefore } from "@/lib/day/weeks";

import { test, expect } from "./fixtures";
import plan from "../messages/es/plan.json";

// RP-15, RP-25: the phase form reads the days its weeks cover, live, and says
// where the goal's last week ends. Dates and week numbers are DM Mono inside
// an Archivo sentence (`FaseFechas`, `FaseFechasFuera`, `FaseFechasSolapa`).

const WIDTHS: [number, number][] = [
  [390, 844],
  [1440, 900],
];

async function expectFigures(line: Locator, figures: string[]) {
  const set = await line.evaluate((el) => ({
    family: getComputedStyle(el).fontFamily,
    spans: Array.from(el.querySelectorAll("span")).map((span) => ({
      text: span.textContent,
      family: getComputedStyle(span).fontFamily,
    })),
  }));
  expect(set.family).not.toMatch(/mono/i);
  expect(set.spans.map((span) => span.text)).toEqual(figures);
  for (const span of set.spans) expect(span.family).not.toMatch(/mono/i);
}

// A goal whose last day is the Wednesday of its week 6, so week 5 is whole and
// week 6 is a partial last week.
async function seedGoal(db: import("postgres").Sql, personId: string) {
  const monday = weekOf(todayInZone())[0];
  // The horizon is the first day after the goal: the Thursday of week 6.
  const horizonDay = dayBefore(dayBefore(dayBefore(addWeeksToCivilDate(monday, 6))));
  const [goal] = await db<{ id: string; name: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${`Meta fechas ${Date.now()}`}, ${horizonDay}::date) returning id, name
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${personId}, ${goal.id}, 'Fundamentos', ${addWeeksToCivilDate(monday, 1)}::date, ${dayBefore(addWeeksToCivilDate(monday, 3))}::date)
  `;
  return { goalId: goal.id, monday, lastDay: dayBefore(horizonDay) };
}

for (const [width, height] of WIDTHS) {
  test(`at ${width}px the phase form reads its dates, its last week and its refusals`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { goalId, monday, lastDay } = await seedGoal(db, person.id);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height },
    });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${goalId}/fases/nueva`);
      const from = page.getByLabel(plan.phaseForm.fromLabel);
      const to = page.getByLabel(plan.phaseForm.toLabel);

      // Week 5: its Monday and its Sunday, in the line's own face.
      await from.fill("5");
      await to.fill("5");
      const mondayFive = addWeeksToCivilDate(monday, 4);
      const sundayFive = dayBefore(addWeeksToCivilDate(monday, 5));
      const live = page.locator("#phase-weeks-hint");
      await expect(live).toContainText(`Del ${civilDateLabel(mondayFive, true)} al ${civilDateLabel(sundayFive, true)}.`);
      await expectFigures(live, [civilDateLabel(mondayFive, true), civilDateLabel(sundayFive, true), "6", civilDateLabel(lastDay)]);
      await expect(from).not.toHaveAttribute("aria-invalid", "true");

      // The goal's partial last week ends on its last day, not on a Sunday.
      await from.fill("6");
      await to.fill("6");
      await expect(live).toContainText(`al ${civilDateLabel(lastDay, true)}.`);

      // Past the last week: the refusal in the hint, the field ringed.
      await to.fill("7");
      await expect(live).toContainText(`La meta llega hasta la semana 6, el ${civilDateLabel(lastDay)}. Elige hasta esa semana o mueve el final.`);
      await expect(to).toHaveAttribute("aria-invalid", "true");
      await expect(to).toHaveAttribute("aria-describedby", "phase-weeks-hint");
      await expect(page.getByRole("link", { name: plan.phaseForm.moveEnd })).toBeVisible();
      await expectFigures(live, ["6", civilDateLabel(lastDay)]);

      // Overlapping «Fundamentos» (weeks 2 to 3): it names them and the next free week.
      await from.fill("3");
      await to.fill("4");
      await expect(live).toContainText("Las semanas 2 a 3 ya son de «Fundamentos». Empieza en la 4.");
      await expect(from).toHaveAttribute("aria-invalid", "true");
      await expectFigures(live, ["2", "3", "4"]);
    } finally {
      await context.close();
    }
  });
}

for (const [width, height] of WIDTHS) {
  test(`at ${width}px «Añadir la fase» under a refusal moves focus to the invalid field and writes nothing`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { goalId } = await seedGoal(db, person.id);
    const phaseCount = async () => {
      const [row] = await db<{ count: string }[]>`select count(*)::text as count from goals.phases where goal_id = ${goalId}`;
      return Number(row.count);
    };
    const before = await phaseCount();
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height },
    });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${goalId}/fases/nueva`);
      const from = page.getByLabel(plan.phaseForm.fromLabel);
      const to = page.getByLabel(plan.phaseForm.toLabel);
      const submit = page.getByRole("button", { name: plan.phaseForm.submit });
      await page.getByLabel(plan.phaseForm.aimLabel).fill("Una fase");

      // Only the end passes the last week: «hasta» is ringed and takes focus.
      await from.fill("6");
      await to.fill("7");
      await expect(to).toHaveAttribute("aria-invalid", "true");
      await expect(from).not.toHaveAttribute("aria-invalid", "true");
      await submit.click();
      await expect(to).toBeFocused();
      expect(await phaseCount()).toBe(before);

      // The start passes it too: «desde» is the one ringed and takes focus.
      await from.fill("7");
      await expect(from).toHaveAttribute("aria-invalid", "true");
      await expect(to).not.toHaveAttribute("aria-invalid", "true");
      await submit.click();
      await expect(from).toBeFocused();
      expect(await phaseCount()).toBe(before);

      // Overlapping «Fundamentos»: «desde» takes focus.
      await to.fill("4");
      await from.fill("3");
      await expect(from).toHaveAttribute("aria-invalid", "true");
      await to.focus();
      await submit.click();
      await expect(from).toBeFocused();
      expect(await phaseCount()).toBe(before);
    } finally {
      await context.close();
    }
  });
}

test("with no week left the form opens empty and offers «Mover el final»", async ({ person, browser, db }) => {
  const monday = weekOf(todayInZone())[0];
  const horizon = addWeeksToCivilDate(monday, 1);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${`Meta sin semanas ${Date.now()}`}, ${horizon}::date) returning id
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${goal.id}, 'Todo', ${todayInZone()}::date, ${dayBefore(horizon)}::date)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/fases/nueva`);
    await expect(page.getByLabel(plan.phaseForm.fromLabel)).toHaveValue("");
    await expect(page.locator("#phase-weeks-hint")).toContainText("La meta llega hasta la semana");
    await expect(page.getByRole("link", { name: plan.phaseForm.moveEnd })).toBeVisible();
  } finally {
    await context.close();
  }
});
